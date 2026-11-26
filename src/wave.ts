import { formatValue, logicState, radixShort } from './design';
import type { Radix, Signal, Vector } from './design';
import type { Frame } from './sim-worker';
import type { Palette } from './schematic';
import { changeAt } from './vcd';
import type { Change } from './simulation';

const labelWidth = 150;
const axisHeight = 28;
const laneHeight = 33;
const rightInset = 12;
const dragThreshold = 5;
const edgeSnapRadius = 7;
const mono = '11px Consolas, monospace';
interface WaveData {
  signals: Signal[];
  start: number;
  end: number;
  cursor: number;
  stepPs: number;
  frame?: Frame;
  palette: Palette;
  radixFor: (signal: Signal) => Radix;
}

function gridStep(span: number, width: number) {
  const approximate = Math.max(1, span / Math.max(1, width / 90));
  const decade = 10 ** Math.floor(Math.log10(approximate));
  return ([1, 2, 5, 10].find(multiplier => multiplier * decade >= approximate) ?? 10) * decade;
}

export function nearestWaveEdge(
  series: readonly (readonly Change<Vector>[])[], time: number, radius: number, start: number, end: number,
) {
  let edge: number | undefined;
  let distance = radius;
  for (const changes of series) {
    const first = Math.max(1, changeAt(changes, Math.max(start, time - distance) - 1));
    for (let index = first; index < changes.length; index++) {
      const next = changes[index];
      if (next.time > Math.min(end, time + distance)) break;
      const delta = Math.abs(next.time - time);
      if (next.time < start || delta > distance ||
          (delta === distance && edge !== undefined && next.time >= edge)) continue;
      if (next.value.every((bit, bitIndex) => bit === changes[index - 1].value[bitIndex])) continue;
      edge = next.time;
      distance = delta;
    }
  }
  return edge;
}

export class Waveform {
  private data?: WaveData;
  private readonly spacer = document.createElement('div');
  private readonly list = document.createElement('div');
  private readonly cursorHandle = document.createElement('div');
  private readonly rows = new Map<string, { row: HTMLElement; value: HTMLElement; base: HTMLButtonElement }>();
  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement, onClick: (time: number, signal?: Signal, alternate?: boolean) => void,
    onZoom: (scale: number, anchor: number) => void, onZoomRange: (start: number, end: number) => void,
    onPan: (start: number, span: number) => void, private onRadix: (signal: Signal, x: number, y: number) => void,
    private remove: (signal: Signal) => void, onAdd: () => void,
    onReorder: (id: string, index: number) => void) {
    const surface = document.createElement('div');
    surface.className = 'wave-surface';
    const heading = document.createElement('div');
    heading.className = 'watch-heading';
    const title = document.createElement('span');
    title.textContent = '信号 / 当前值';
    const add = document.createElement('button');
    add.type = 'button';
    add.id = 'wave-add-signal';
    add.textContent = '+';
    add.title = '添加波形信号';
    add.setAttribute('aria-label', add.title);
    add.setAttribute('aria-haspopup', 'dialog');
    add.onclick = onAdd;
    heading.append(title, add);
    heading.style.width = this.list.style.width = labelWidth + 'px';
    heading.style.height = this.list.style.top = axisHeight + 'px';
    this.list.className = 'watch-list';
    const selection = document.createElement('div');
    selection.className = 'wave-zoom-selection';
    selection.hidden = true;
    const handle = this.cursorHandle;
    handle.className = 'wave-cursor-handle';
    handle.tabIndex = 0;
    handle.hidden = true;
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', '波形时间光标');
    surface.append(canvas, heading, this.list, selection, handle);
    let cursorDrag: { id: number; offset: number } | undefined;
    const moveCursor = (event: PointerEvent) => {
      if (cursorDrag?.id !== event.pointerId || !this.data) return;
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left - cursorDrag.offset;
      const y = event.clientY - bounds.top;
      onClick(this.snappedCursorTime(x, y) ?? Math.round(this.timeAt(x)));
    };
    handle.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      const rect = handle.getBoundingClientRect();
      cursorDrag = { id: event.pointerId, offset: event.clientX - rect.left - rect.width / 2 };
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
    });
    document.addEventListener('pointermove', event => {
      if (cursorDrag?.id !== event.pointerId) return;
      if (!(event.buttons & 1)) { cursorDrag = undefined; return; }
      moveCursor(event);
    });
    document.addEventListener('pointerup', event => {
      if (cursorDrag?.id !== event.pointerId) return;
      moveCursor(event);
      cursorDrag = undefined;
    });
    document.addEventListener('pointercancel', event => {
      if (cursorDrag?.id === event.pointerId) cursorDrag = undefined;
    });
    handle.addEventListener('keydown', event => {
      if (!this.data || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      const { start, end, cursor } = this.data;
      handle.classList.remove('edge-snapped');
      onClick(Math.max(start, Math.min(end, cursor + (event.key === 'ArrowLeft' ? -1 : 1))));
    });
    host.append(surface, this.spacer);
    this.bindReorder(onReorder);
    new ResizeObserver(() => this.paint()).observe(host);
    host.addEventListener('scroll', () => this.paint(), { passive: true });
    const alternateClick = (offsetX: number, offsetY: number) => {
      if (!this.data) return;
      if (offsetX < labelWidth) return;
      const time = this.tick(offsetX);
      const signal = offsetY >= axisHeight ? this.signalAt(offsetY) : undefined;
      if (offsetY < axisHeight || signal) onClick(time, signal, true);
    };
    let drag: { id: number; x: number; y: number; clientX: number; button: number; start: number; span: number; moved: boolean } | undefined;
    const point = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      return {
        x: Math.max(labelWidth, Math.min(canvas.clientWidth - rightInset, event.clientX - bounds.left)),
        y: Math.max(0, Math.min(canvas.clientHeight, event.clientY - bounds.top)),
      };
    };
    canvas.addEventListener('pointerdown', event => {
      if (!event.isPrimary || (event.button !== 0 && event.button !== 2)) return;
      const data = this.data;
      if (!data || !this.inPlot(event.offsetX)) return;
      drag = { id: event.pointerId, ...point(event), clientX: event.clientX, button: event.button,
        start: data.start, span: data.end - data.start, moved: false };
      canvas.title = '';
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
    });
    const pan = (clientX: number, gesture: NonNullable<typeof drag>) => {
      const delta = (clientX - gesture.clientX) * gesture.span / Math.max(1, canvas.clientWidth - labelWidth - rightInset);
      onPan(gesture.start - delta, gesture.span);
    };
    canvas.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      const { x, y } = point(event);
      const width = Math.abs(x - drag.x);
      drag.moved ||= Math.hypot(event.clientX - drag.clientX, y - drag.y) >= dragThreshold;
      if (!drag.moved) return;
      if (drag.button === 2) {
        canvas.classList.add('wave-panning');
        pan(event.clientX, drag);
        return;
      }
      selection.hidden = width < dragThreshold;
      canvas.classList.toggle('wave-selecting', !selection.hidden);
      selection.style.left = Math.min(x, drag.x) + 'px';
      selection.style.width = width + 'px';
    });
    const clearSelection = (event: PointerEvent) => {
      if (drag?.id !== event.pointerId) return;
      drag = undefined;
      selection.hidden = true;
      canvas.classList.remove('wave-panning', 'wave-selecting');
    };
    canvas.addEventListener('pointerup', event => {
      if (drag?.id !== event.pointerId) return;
      const { x, y } = point(event);
      const moved = drag.moved || Math.hypot(event.clientX - drag.clientX, y - drag.y) >= dragThreshold;
      if (drag.button === 2) {
        const gesture = drag;
        clearSelection(event);
        if (moved) pan(event.clientX, gesture);
        else alternateClick(x, y);
        return;
      }
      const left = Math.min(x, drag.x);
      const right = Math.max(x, drag.x);
      clearSelection(event);
      if (right - left >= dragThreshold && this.data) {
        onZoomRange(Math.floor(this.timeAt(left) + 1e-7), Math.ceil(this.timeAt(right) - 1e-7));
      }
    });
    canvas.addEventListener('pointercancel', clearSelection);
    canvas.addEventListener('lostpointercapture', clearSelection);
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    canvas.addEventListener('wheel', event => {
      if (!event.deltaY || !this.inPlot(event.offsetX)) return;
      event.preventDefault();
      if (drag) return;
      canvas.focus({ preventScroll: true });
      onZoom(event.deltaY < 0 ? 2 / 3 : 1.5, this.timeAt(event.offsetX));
    }, { passive: false });
    canvas.addEventListener('mousemove', event => {
      if (drag || !this.data) return;
      if (event.offsetX < labelWidth) {
        canvas.title = '';
        return;
      }
      const time = this.tick(event.offsetX);
      const signal = event.offsetY >= axisHeight ? this.signalAt(event.offsetY) : undefined;
      const changes = signal && this.data.frame?.waves[signal.id];
      const value = time <= (this.data.frame?.waveEnd ?? -1) ? changes?.findLast(change => change.time <= time)?.value : undefined;
      canvas.title = `${time * this.data.stepPs / 1000} ns${value && signal ? ' · ' + formatValue(value, this.data.radixFor(signal)) : ''}${signal?.editable && !signal.clock ? ' · 右键编辑输入' : ''}`;
    });
  }

  private bindReorder(onReorder: (id: string, index: number) => void) {
    const indicator = document.createElement('div');
    indicator.className = 'watch-drop-indicator';
    indicator.hidden = true;
    this.list.append(indicator);
    let drag: { pointer: number; id: string; originY: number; y: number; moved: boolean } | undefined;
    let animation = 0;

    const destination = (y: number) => {
      const length = this.data?.signals.length ?? 0;
      const offset = y - this.list.getBoundingClientRect().top + this.host.scrollTop;
      return Math.max(0, Math.min(length - 1, Math.floor(offset / laneHeight)));
    };
    const update = () => {
      if (!drag?.moved || !this.data) return;
      const bounds = this.list.getBoundingClientRect();
      if (drag.y < bounds.top + 18) this.host.scrollTop -= 7;
      else if (drag.y > bounds.bottom - 18) this.host.scrollTop += 7;
      const origin = this.data.signals.findIndex(signal => signal.id === drag!.id);
      const index = destination(drag.y);
      const y = (index + (index > origin ? 1 : 0)) * laneHeight - this.host.scrollTop;
      this.rows.get(drag.id)?.row.classList.add('watch-dragging');
      indicator.hidden = origin < 0 || index === origin;
      indicator.style.top = Math.max(0, Math.min(bounds.height - 2, y)) + 'px';
      animation = requestAnimationFrame(update);
    };
    const endDrag = () => {
      if (drag) this.rows.get(drag.id)?.row.classList.remove('watch-dragging');
      drag = undefined;
      indicator.hidden = true;
      cancelAnimationFrame(animation);
      animation = 0;
    };
    this.list.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || !(event.target instanceof HTMLElement)) return;
      if (!event.target.closest('.watch-name, .watch-value')) return;
      const id = event.target.closest<HTMLElement>('.watch-row')?.dataset.signalId;
      if (id === undefined) return;
      event.preventDefault();
      drag = { pointer: event.pointerId, id, originY: event.clientY, y: event.clientY, moved: false };
      this.rows.get(id)?.row.classList.add('watch-dragging');
      this.list.setPointerCapture(event.pointerId);
    });
    document.addEventListener('pointermove', event => {
      if (drag?.pointer !== event.pointerId) return;
      if (!(event.buttons & 1)) { endDrag(); return; }
      drag.y = event.clientY;
      if (drag.moved || Math.abs(drag.y - drag.originY) < dragThreshold) return;
      drag.moved = true;
      animation = requestAnimationFrame(update);
    });
    document.addEventListener('pointerup', event => {
      if (drag?.pointer !== event.pointerId) return;
      const { id, moved, originY } = drag;
      endDrag();
      if (moved || Math.abs(event.clientY - originY) >= dragThreshold) onReorder(id, destination(event.clientY));
    });
    document.addEventListener('pointercancel', event => {
      if (drag?.pointer === event.pointerId) endDrag();
    });
  }

  update(data: WaveData) {
    this.data = data;
    this.canvas.setAttribute('aria-description', `可见范围 ${data.start * data.stepPs / 1000}–${data.end * data.stepPs / 1000} ns`);
    this.paint();
  }

  private inPlot(x: number) {
    return !!this.data && x >= labelWidth && x < this.canvas.clientWidth - rightInset;
  }

  private timeAt(x: number) {
    const { start, end } = this.data!;
    const ratio = (x - labelWidth) / Math.max(1, this.canvas.clientWidth - labelWidth - rightInset);
    return Math.max(start, Math.min(end, start + ratio * (end - start)));
  }

  private tick(x: number) {
    return Math.floor(this.timeAt(x) + 1e-7);
  }

  private snappedCursorTime(x: number, y: number) {
    const data = this.data;
    if (!data) return undefined;
    const plotWidth = this.canvas.clientWidth - labelWidth - rightInset;
    const signal = y >= axisHeight ? this.signalAt(y) : undefined;
    const first = Math.floor(this.host.scrollTop / laneHeight);
    const last = Math.ceil((this.host.scrollTop + this.host.clientHeight - axisHeight) / laneHeight);
    const candidates = signal ? [signal] : data.signals.slice(first, last);
    const edge = plotWidth > 0 && this.inPlot(x) ? nearestWaveEdge(
      candidates.map(item => data.frame?.waves[item.id] ?? []),
      this.timeAt(x), edgeSnapRadius * (data.end - data.start) / plotWidth,
      data.start, Math.min(data.end, data.frame?.waveEnd ?? -1),
    ) : undefined;
    this.cursorHandle.classList.toggle('edge-snapped', edge !== undefined);
    return edge;
  }

  private signalAt(y: number) {
    return this.data?.signals[Math.floor((y - axisHeight + this.host.scrollTop) / laneHeight)];
  }

  private paintList(data: WaveData, height: number, scroll: number) {
    const visible = new Set<string>();
    const first = Math.floor(scroll / laneHeight);
    const stop = Math.min(data.signals.length, Math.ceil((scroll + height - axisHeight) / laneHeight));
    let previous = this.list.firstElementChild!;
    for (let i = first; i < stop; i++) {
      const signal = data.signals[i];
      visible.add(signal.id);
      let controls = this.rows.get(signal.id);
      if (!controls) {
        const row = document.createElement('div');
        row.className = 'watch-row';
        row.dataset.signalId = signal.id;
        row.style.height = laneHeight + 'px';
        const remove = document.createElement('button');
        remove.className = 'watch-remove close-icon';
        remove.title = '移除 ' + signal.name;
        const name = document.createElement('span');
        name.className = 'watch-name'; name.textContent = (signal.clock ? '◷ ' : '') + signal.name; name.title = signal.name + ' · 按住左键拖动排序';
        const value = document.createElement('span');
        value.className = 'watch-value';
        const base = document.createElement('button');
        base.className = 'radix-chip'; base.title = signal.name + ' 的波形显示进制';
        row.append(remove, name, value, base);
        this.list.append(row);
        controls = { row, value, base };
        this.rows.set(signal.id, controls);
      }
      const { row, value, base } = controls;
      row.style.top = (i * laneHeight - scroll) + 'px';
      if (previous.nextElementSibling !== row) previous.after(row);
      previous = row;
      const bits = signal.bits?.map(bit => typeof bit === 'number' ? data.frame?.values[bit] ?? 'x' : bit) ?? [];
      const radix = data.radixFor(signal);
      value.textContent = value.title = formatValue(bits, radix);
      value.style.color = data.palette[logicState(bits)];
      base.textContent = radixShort[radix];
      row.onclick = event => {
        if (event.target === row.firstElementChild) this.remove(signal);
        if (event.target === base) {
          const rect = base.getBoundingClientRect();
          this.onRadix(signal, rect.left, rect.bottom);
        }
      };
    }
    for (const [id, controls] of this.rows) if (!visible.has(id)) {
      controls.row.remove(); this.rows.delete(id);
    }
  }

  private paint() {
    if (!this.data) return;
    const { start, end, signals, cursor, frame, palette, radixFor, stepPs } = this.data;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width <= labelWidth + rightInset + 1 || height <= 0) return;
    const device = window.devicePixelRatio;
    this.spacer.style.height = Math.max(0, axisHeight + signals.length * laneHeight - height) + 'px';
    const verticalOffset = this.host.scrollTop;
    this.paintList(this.data, height, verticalOffset);
    this.canvas.style.height = height + 'px';
    this.canvas.width = Math.round(width * device);
    this.canvas.height = Math.round(height * device);
    const ctx = this.canvas.getContext('2d')!;
    ctx.scale(device, device);
    const graphWidth = width - labelWidth - rightInset;
    const colors = getComputedStyle(this.canvas);
    const color = (property: string, fallback: string) => colors.getPropertyValue(property).trim() || fallback;
    const gridColor = color('--wave-grid', '#283340');
    const dividerColor = color('--wave-divider', '#394758');
    const tickColor = color('--wave-tick', '#758397');
    const textColor = color('--wave-text', '#a3afbf');
    const cursorColor = color('--wave-cursor', '#68ebd5');
    const x = (time: number) => labelWidth + (time - start) * graphWidth / Math.max(1, end - start);
    ctx.fillStyle = color('--wave-background', '#111821'); ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = color('--wave-label-background', '#1a2430'); ctx.fillRect(0, 0, labelWidth, height);
    ctx.font = mono;
    ctx.textBaseline = 'middle';
    const line = (x1: number, y1: number, x2: number, y2: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };
    const grid = gridStep(end - start, graphWidth);
    const minor = grid / 10;
    for (let index = Math.ceil(start / minor); index <= Math.floor(end / minor); index++) {
      if (index % 10 === 0) continue;
      const at = x(index * minor);
      const mid = index % 5 === 0;
      line(at, axisHeight - (mid ? 8 : 4), at, axisHeight, mid ? tickColor : color('--wave-tick', '#535f70'));
      if (minor >= 1) line(at, axisHeight, at, height, color('--wave-grid', mid ? '#222d3a' : '#19222e'));
    }
    for (let time = Math.ceil(start / grid) * grid; time <= end; time += grid) {
      const at = x(time);
      line(at, 0, at, height, gridColor);
      const text = String(time * stepPs / 1000);
      ctx.fillStyle = textColor;
      ctx.fillText(text, Math.max(labelWidth + 3, Math.min(at + 3, width - ctx.measureText(text).width - 3)), 13);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(labelWidth, axisHeight, graphWidth, height - axisHeight); ctx.clip();
    signals.forEach((signal, index) => {
      const y = axisHeight + index * laneHeight - verticalOffset;
      if (y + laneHeight <= axisHeight || y >= height) return;
      line(0, y + laneHeight, width, y + laneHeight, color('--wave-grid', '#25303e'));
      const changes = frame?.waves[signal.id] ?? [];
      const radix = radixFor(signal);
      let previousY: number | undefined;
      changes.forEach((change, i) => {
        const left = x(change.time);
        const final = Math.min(end, frame?.waveEnd ?? -1);
        const right = x(changes[i + 1]?.time ?? final);
        if (right < left) return;
        const color = palette[logicState(change.value)];
        if (signal.width === 1) {
          const bit = change.value[0];
          const level = y + (bit === '1' ? 7 : bit === '0' ? 25 : 16);
          if (previousY !== undefined) line(left, previousY, left, level, color);
          if (bit === 'x' || bit === 'z') ctx.setLineDash(bit === 'z' ? [4, 3] : [2, 2]);
          line(left, level, right, level, color);
          ctx.setLineDash([]);
          previousY = level;
        } else {
          this.drawBus(ctx, left, right, y, color, change.value, radix);
        }
      });
    });
    if (!signals.length) {
      ctx.fillStyle = textColor;
      ctx.fillText('从信号列表添加观察点。', labelWidth + 16, axisHeight + 20);
    }
    ctx.restore();
    line(0, axisHeight, width, axisHeight, dividerColor);
    line(labelWidth, 0, labelWidth, height, dividerColor);
    const handle = this.cursorHandle;
    handle.hidden = cursor < start || cursor > end;
    if (!handle.hidden) {
      const at = x(cursor);
      const toNs = (time: number) => String(Number((time * stepPs / 1000).toPrecision(12)));
      handle.style.left = at + 'px';
      handle.title = '拖动光标 · ' + toNs(cursor) + ' ns';
      handle.setAttribute('aria-valuemin', toNs(start));
      handle.setAttribute('aria-valuemax', toNs(end));
      handle.setAttribute('aria-valuenow', toNs(cursor));
      handle.setAttribute('aria-valuetext', toNs(cursor) + ' ns');
      line(at, 0, at, height, cursorColor);
    }
  }

  private drawBus(ctx: CanvasRenderingContext2D, left: number, right: number, y: number, color: string, value: Vector, radix: Radix) {
    const inset = Math.min(4, (right - left) / 2);
    ctx.beginPath();
    ctx.moveTo(left, y + 16);
    ctx.lineTo(left + inset, y + 8); ctx.lineTo(right - inset, y + 8);
    ctx.lineTo(right, y + 16); ctx.lineTo(right - inset, y + 24);
    ctx.lineTo(left + inset, y + 24); ctx.closePath();
    ctx.strokeStyle = color;
    ctx.stroke();
    const text = formatValue(value, radix);
    if (ctx.measureText(text).width < right - left - 13) {
      ctx.fillStyle = color;
      ctx.fillText(text, left + 7, y + 16);
    }
  }
}
