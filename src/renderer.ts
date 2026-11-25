import { changeAt } from './vcd';
import type { WaveTrace } from './vcd';
import type { TestbenchResult } from './testbench';
import { workbench } from '../vscode/src/web-platform';
import './style.css';
import { compile, formatValue, parseValue, radixShort } from './design';
import type { Design, Logic, Part, Radix, Signal, Vector } from './design';
import type { BuildOptions, Diagnostic, Source } from './protocol';
import { Schematic, defaultPalette } from './schematic';
import type { Palette } from './schematic';
import type { Frame, Request } from './sim-worker';
import { defaultDelay } from './simulation';
import { criticalPath } from './critical-path';
import type { Duration } from './simulation';
import { Waveform } from './wave';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => el<HTMLButtonElement>(id);
const input = (id: string) => el<HTMLInputElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);
const dialog = (id: string) => el<HTMLDialogElement>(id);
const on = (id: string, event: string, handler: () => void) => el(id).addEventListener(event, handler);
const modes = ['rtl', 'gate'] as const;
let selectedMode: BuildOptions['mode'] = 'rtl';
const options = (): BuildOptions => ({
  standard: select('standard').value as BuildOptions['standard'],
  top: input('top').value.trim(),
  mode: selectedMode,
  hierarchy: input('hierarchy').checked,
  optimize: input('optimize').checked,
  abc: input('abc').checked,
  observe: input('observe').checked,
  extraCommands: lines('extra-commands'), includes: lines('includes'), defines: lines('defines'), parameters: lines('parameters'),
});
function lines(id: string) { return el<HTMLTextAreaElement>(id).value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }

let revision = 0;
let jobSequence = 0;
let lintTimer: ReturnType<typeof setTimeout>;
let lintBusy = false;
let lintQueued = false;
let synthesisBusy = false;
let synthesisQueued = false;
let logMode: 'lint' | 'synth' = 'lint';
let design: Design | undefined;
let trace: WaveTrace | undefined;
const testbenchView = document.body.classList.contains('testbench-view');
let scopes: string[] = [];
let watched = new Set<string>();
const probes = new Map<string, Signal>();
const displayRadices = new Map<string, Radix>();
let chipType = '';
let inspector: 'signals' | 'parts' = 'signals';
const lightPalette: Palette = { '0': '#456e8d', '1': '#168052', x: '#985a0a', z: '#7545a1' };
const customPalette: Partial<Palette> = {};
function themedPalette(): Palette {
  return { ...(document.body.classList.contains('vscode-light') ? lightPalette : defaultPalette), ...customPalette };
}
const clockOverrides = new Map<string, number>();
const cellDelays = new Map<string, number>();
try {
  const saved = JSON.parse(localStorage.getItem('verilog-palette') ?? '{}');
  for (const state of Object.keys(defaultPalette) as Logic[]) if (/^#[0-9a-f]{6}$/i.test(saved[state] ?? '')) customPalette[state] = saved[state];
} catch { /* Defaults also work when storage is unavailable. */ }
let palette = themedPalette();

const worker = workbench.worker('sim-worker');
let version = 0;
let frame: Frame | undefined;
let pendingFrame: Frame | undefined;
let framePaint = 0;
let simulationError = '';
let cursor = 0;
let viewStart = 0;
let stepPs = 50;
let period = 20;
let end = 2000;
let viewSpan = end;
const nsAt = (tick: number) => Number((tick * stepPs / 1000).toPrecision(12));
const simTiming = () => ({ period, end });
const playbackNsPerSecond = 10;
let playing = false;
let playTimer: ReturnType<typeof setInterval> | undefined;
let buildRevision = -1;
let builtMode: BuildOptions['mode'] | undefined;
const signalCatalog = () => trace?.signals ?? design?.signals ?? [];
const watchedSignals = () => [...watched].flatMap(id => probes.get(id) ?? signalCatalog().find(signal => signal.id === id) ?? []);
const radixFor = (signal: Signal): Radix => displayRadices.get(signal.id) ?? (signal.real ? 'real' : signal.width === 1 ? 'bin' : 'hex');
const viewEnd = () => Math.min(end, viewStart + viewSpan);
const schematic = new Schematic(
  el('schematic'), handlePart,
  (signal, x, y, aliases) => signalMenu(signal, x, y, false, aliases),
  () => workbench.worker('layout-worker'),
  workbench.elkWorkerUrl,
);
const waveform = new Waveform(el('wave'), el('wave-scroll'), handleWave, zoomWave,
  (start, finish) => setView(start, finish - start), panWave, openRadixMenu, signal => {
  setWatched(signal, false);
  renderInspector();
}, showWaveSignals, (id, index) => {
  const order = [...watched];
  const from = order.indexOf(id);
  if (from < 0 || from === index) return;
  order.splice(from, 1);
  order.splice(index, 0, id);
  watched = new Set(order);
  draw();
});

const radixLabels: Record<Radix, string> = { bin: '二进制', hex: '十六进制', uint: '无符号十进制', int: '有符号十进制', real: 'Real（IEEE 754）' };
function setDisplayRadix(signal: Signal, format: Radix) {
  displayRadices.set(signal.id, format);
  draw();
  renderInspector();
}
function openRadixMenu(signal: Signal, x: number, y: number) { signalMenu(signal, x, y, true); }

function setWatched(signal: Signal, watch: boolean) {
  if (watch) {
    if (!signalCatalog().some(item => item.id === signal.id)) probes.set(signal.id, signal);
    watched.add(signal.id);
  } else watched.delete(signal.id);
  draw();
  request();
}

function showWaveSignals() {
  input('wave-signal-filter').value = '';
  renderWaveSignalPicker();
  dialog('wave-signals-dialog').showModal();
  input('wave-signal-filter').focus();
}
function renderWaveSignalPicker() {
  const filter = input('wave-signal-filter').value.trim().toLowerCase();
  const signals = [...signalCatalog(), ...probes.values()].filter(signal =>
    signal.bits && signal.name.toLowerCase().includes(filter));
  const options = el('wave-signal-options');
  options.replaceChildren(...signals.map(signal => {
    const label = document.createElement('label');
    const choice = document.createElement('input');
    choice.type = 'checkbox';
    choice.checked = watched.has(signal.id);
    choice.onchange = () => {
      setWatched(signal, choice.checked);
      renderInspector();
      if (choice.checked) el('wave-scroll').scrollTop = el('wave-scroll').scrollHeight;
    };
    const name = document.createElement('span');
    name.textContent = signal.name;
    name.title = signal.name;
    const width = document.createElement('span');
    width.textContent = signal.width + 'b';
    label.append(choice, name, width);
    return label;
  }));
  if (!signals.length) options.textContent = design || trace ? '没有匹配的可观察信号。' : testbenchView ? '尚未载入波形。' : '请先综合设计。';
}

function signalMenu(signal: Signal, x: number, y: number, radixOnly = false, aliases?: Signal[]) {
  if (!signal.bits) return;
  const menu = el('signal-menu');
  const title = document.createElement('div');
  title.className = 'signal-menu-title';
  title.textContent = signal.name;
  menu.replaceChildren(title);
  if (aliases && aliases.length > 1) {
    const variable = document.createElement('select');
    variable.setAttribute('aria-label', '选择导线上的变量');
    for (const alias of aliases) variable.add(new Option(alias.name, alias.id));
    variable.value = signal.id;
    variable.onchange = () => signalMenu(aliases.find(s => s.id === variable.value)!, x, y, radixOnly, aliases);
    menu.replaceChildren(variable);
  }
  const action = (label: string, run: () => void, checked?: boolean) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemradio');
    if (checked !== undefined) item.setAttribute('aria-checked', String(checked));
    item.onclick = () => { menu.hidden = true; run(); };
    menu.append(item);
  };
  const added = watched.has(signal.id);
  if (!radixOnly) action(added ? '从波形观察窗移除' : '添加到波形观察窗', () => {
    setWatched(signal, !added);
    renderInspector();
    if (!added) el('wave-scroll').scrollTop = el('wave-scroll').scrollHeight;
  });
  for (const [format, label] of Object.entries(radixLabels) as [Radix, string][]) {
    if (format === 'real' && signal.width !== 32 && signal.width !== 64) continue;
    action(label, () => setDisplayRadix(signal, format), radixFor(signal) === format);
  }
  menu.hidden = false;
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.querySelector('button')?.focus();
}

document.addEventListener('pointerdown', event => {
  const menu = el('signal-menu');
  if (!menu.contains(event.target as Node)) menu.hidden = true;
});
document.addEventListener('keydown', event => {
  const menu = el('signal-menu');
  if (menu.hidden) return;
  if (event.key === 'Escape') menu.hidden = true;
  if (event.target instanceof HTMLSelectElement) return;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const items = [...menu.querySelectorAll('button')];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
});

function status(message: string, error = false) {
  el('status').textContent = message;
  el('status').title = message;
  el('status').classList.toggle('error', error);
}

let hostSources: Pick<Source, 'id' | 'name'>[] = [];
function inputsChanged() {
  revision++;
  if (design && buildRevision !== revision) el('net-status').textContent = '源码或综合设置已变更';
  queueLint();
}
function queueLint() {
  clearTimeout(lintTimer);
  if (!hostSources.length) {
    el('lint-status').textContent = '';
    applyDiagnostics([]);
    return;
  }
  if (!input('live-lint').checked) {
    el('lint-status').textContent = '检查已关闭';
    applyDiagnostics([]);
    return;
  }
  el('lint-status').textContent = '待检查';
  lintTimer = setTimeout(() => { void lint(); }, 420);
}

async function lint() {
  if (!input('live-lint').checked) return;
  if (lintBusy) { lintQueued = true; return; }
  lintBusy = true;
  const started = revision;
  const job = ++jobSequence;
  el('lint-status').textContent = '检查中…';
  try {
    const result = await workbench.hdl(options(), true);
    if (started !== revision || job !== jobSequence) return;
    applyDiagnostics(result.diagnostics);
    const errors = result.diagnostics.filter(item => item.severity === 'error').length;
    el('lint-status').textContent = errors ? `${errors} 个错误` : !result.ok ? '检查失败' : result.diagnostics.length ? `${result.diagnostics.length} 条诊断` : '语法通过';
    el('lint-status').classList.toggle('error', !result.ok);
    if (logMode === 'lint') el('log').textContent = result.log;
  } catch (error) {
    if (started === revision) { el('lint-status').textContent = '检查失败'; status(String(error), true); }
  } finally {
    lintBusy = false;
    if (lintQueued) { lintQueued = false; void lint(); }
  }
}

function applyDiagnostics(diagnostics: Diagnostic[]) {
  el('diagnostics').replaceChildren(...diagnostics.map(item => {
    const control = document.createElement('button');
    control.textContent = `${hostSources.find(source => source.id === item.id)?.name ?? item.id}:${item.line}:${item.column} · ${item.message}`;
    control.classList.toggle('error', item.severity === 'error');
    control.onclick = () => workbench.reveal(item);
    return control;
  }));
}

async function synthesize() {
  if (synthesisBusy) { synthesisQueued = true; return; }
  const currentOptions = options();
  const started = revision;
  synthesisBusy = true;
  button('synthesize').disabled = true;
  el('schematic').setAttribute('aria-busy', 'true');
  ++jobSequence;
  logMode = 'synth';
  status('正在综合…');
  try {
    const result = await workbench.hdl(currentOptions, false);
    if (synthesisQueued) return;
    if (started !== revision) { status('综合期间源码或设置已修改，请重新综合。'); return; }
    el('log').textContent = result.log;
    if (result.diagnostics.length) applyDiagnostics(result.diagnostics);
    if (!result.ok || !result.netlist || !result.top) {
      selectWorkbenchTab(button('view-log'));
      status('综合失败，请查看诊断与日志。', true);
      return;
    }
    const nextDesign = compile(result.netlist, result.top, result.sourceNetlist);
    const sameTop = nextDesign.root === design?.root && !simulationError;
    stop();
    design = nextDesign;
    for (const id of probes.keys()) displayRadices.delete(id);
    probes.clear();
    buildRevision = revision;
    builtMode = currentOptions.mode;
    scopes = [design.root];
    if (sameTop) watched = new Set([...watched].filter(id => nextDesign.signals.some(signal => signal.id === id && signal.bits)));
    else {
      watched = new Set(design.signals.filter(signal => signal.direction && (signal.editable || !signal.name.includes('.'))).slice(0, 16).map(signal => signal.id));
      cursor = viewStart = 0; viewSpan = end;
      clockOverrides.clear(); cellDelays.clear();
      displayRadices.clear();
    }
    frame = undefined;
    chipType = ''; simulationError = '';
    el('net-status').textContent = result.top + (builtMode === 'gate' ? ' · 门级' : ' · RTL');
    renderInspector();
    showScope();
    draw();
    request({ type: 'load', design, timing: simTiming() });
    status(`综合完成 · ${design.cells.length} 个元件`);
  } catch (error) {
    if (synthesisQueued) return;
    selectWorkbenchTab(button('view-log'));
    status(String(error), true);
  } finally {
    synthesisBusy = false;
    if (synthesisQueued) {
      synthesisQueued = false;
      void synthesize();
    } else {
      if (builtMode && selectedMode !== builtMode) setModeTab(builtMode);
      button('synthesize').disabled = false;
      el('schematic').setAttribute('aria-busy', 'false');
    }
  }
}

const workbenchTabs = ['view-diagram', 'view-wave', 'view-log'].map(button);
function selectWorkbenchTab(selected: HTMLButtonElement) {
  for (const tab of workbenchTabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    el(tab.getAttribute('aria-controls')!).hidden = !active;
  }
}
function bindWorkbenchTabs() {
  for (const tab of workbenchTabs) {
    tab.onclick = () => selectWorkbenchTab(tab);
    tab.onkeydown = event => {
      const visible = workbenchTabs.filter(item => !item.hidden);
      const index = visible.indexOf(tab);
      const last = visible.length - 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? last
        : event.key === 'ArrowRight' ? (index + 1) % visible.length
        : event.key === 'ArrowLeft' ? (index + last) % visible.length : undefined;
      if (next === undefined) return;
      event.preventDefault();
      selectWorkbenchTab(visible[next]);
      visible[next].focus();
    };
  }
  if (testbenchView) button('view-diagram').hidden = true;
  selectWorkbenchTab(button(testbenchView ? 'view-wave' : 'view-diagram'));
}

const signalGlyphs = {
  clock: ['时钟', 'M2.5 9.75H5v-5h6v5h2.5v1.5H9.5v-5h-3v5h-4z'],
  input: ['输入', 'M5 4h6v1.5H8.75v5H11V12H5v-1.5h2.25v-5H5z'],
  output: ['输出', 'M8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
} as const;

function signalIcon(kind: keyof typeof signalGlyphs) {
  const [label, glyph] = signalGlyphs[kind];
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('class', `signal-icon ${kind}`);
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', label);
  const shape = document.createElementNS(namespace, 'path');
  shape.setAttribute('fill-rule', 'evenodd');
  shape.setAttribute('d', `M1 1h14v14H1z ${glyph}`);
  const outline = document.createElementNS(namespace, 'rect');
  outline.setAttribute('x', '1'); outline.setAttribute('y', '1');
  outline.setAttribute('width', '14'); outline.setAttribute('height', '14');
  icon.append(shape, outline);
  return icon;
}

function renderInspector() {
  const filter = input('signal-filter').value.trim().toLowerCase();
  const signals = (design?.signals ?? []).filter(signal => signal.name.toLowerCase().includes(filter));
  const partCounts = new Map<string, number>();
  for (const cell of design?.cells ?? []) partCounts.set(cell.type, (partCounts.get(cell.type) ?? 0) + 1);
  el('inspector-count').textContent = String(inspector === 'signals' ? signals.length : design?.cells.length ?? 0);
  el('signal-pane').hidden = inspector !== 'signals';
  el('part-pane').hidden = inspector !== 'parts';
  button('zero-delays').disabled = button('reset-delays').disabled = !partCounts.size;
  button('show-signals').classList.toggle('selected', inspector === 'signals');
  button('show-parts').classList.toggle('selected', inspector === 'parts');
  el('signals').replaceChildren(...signals.map(signal => {
    const li = document.createElement('li');
    li.className = 'signal-row';
    const control = document.createElement('button');
    control.disabled = !signal.bits;
    control.className = 'signal-control';
    control.title = signal.bits ? '点击以在波形图中添加/移除' : '该源码信号在当前网表中不可观察';
    const name = document.createElement('span');
    name.className = 'signal-name';
    name.textContent = signal.name;
    const tag = document.createElement('span');
    tag.className = 'tag';
    const kind = signal.clock ? 'clock' : signal.direction;
    if (kind === 'clock' || kind === 'input' || kind === 'output') control.append(signalIcon(kind));
    const watchMark = document.createElement('span');
    watchMark.className = 'watch-mark';
    watchMark.setAttribute('aria-hidden', 'true');
    tag.append(`${kind === 'inout' ? '双向 ' : ''}${signal.width}b`, watchMark);
    control.append(name, tag);
    const updateWatch = () => {
      const active = watched.has(signal.id);
      control.setAttribute('aria-pressed', String(active));
      watchMark.dataset.state = signal.bits ? (active ? 'added' : 'available') : 'unavailable';
      tag.classList.toggle('watched', active);
    };
    updateWatch();
    control.onclick = () => { setWatched(signal, !watched.has(signal.id)); updateWatch(); };
    li.append(control);
    if (signal.bits) {
      const display = document.createElement('button');
      display.type = 'button';
      display.className = 'radix-chip';
      display.textContent = radixShort[radixFor(signal)];
      display.setAttribute('aria-label', `${signal.name} 的显示进制`);
      display.onclick = () => {
        const rect = display.getBoundingClientRect();
        openRadixMenu(signal, rect.left, rect.bottom);
      };
      li.append(display);
    }
    return li;
  }));
  el('parts').replaceChildren(...[...partCounts].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => {
    const li = document.createElement('li');
    li.className = 'part-row';
    const control = document.createElement('button');
    control.title = type;
    const label = document.createElement('span');
    label.className = 'part-name'; label.textContent = type;
    const quantity = document.createElement('span'); quantity.textContent = '×' + count;
    control.append(label, quantity);
    control.classList.toggle('selected', chipType === type);
    control.onclick = () => {
      chipType = chipType === type ? '' : type;
      const existing = design?.scopes.find(scope => scope.id === scopes.at(-1));
      const containing = chipType && !existing?.parts.some(part => part.type === chipType) && design?.scopes.find(scope => scope.parts.some(part => part.type === chipType));
      if (containing) {
        const path = JSON.parse(containing.id) as string[];
        scopes = path.map((_, index) => JSON.stringify(path.slice(0, index + 1)));
        showScope();
      }
      renderInspector(); draw();
    };
    const delay = document.createElement('input');
    delay.type = 'number'; delay.min = '0'; delay.max = '10000'; delay.step = '1';
    delay.value = String(cellDelays.get(type) ?? defaultDelay(type));
    delay.setAttribute('aria-label', type + ' 仿真延迟');
    delay.onchange = () => {
      if (!delay.checkValidity() || delay.value === '') { delay.reportValidity(); delay.value = String(cellDelays.get(type) ?? defaultDelay(type)); return; }
      cellDelays.set(type, delay.valueAsNumber);
      refreshCriticalPath();
      simulationError = '';
      request({ type: 'delay', cell: type, delay: delay.valueAsNumber });
    };
    li.append(control, delay);
    return li;
  }));
}

function showScope() {
  if (!design) return;
  el('scope-path').replaceChildren(...scopes.map((id, index) => {
    const element = document.createElement(index === scopes.length - 1 ? 'span' : 'button');
    element.textContent = (JSON.parse(id) as string[]).at(-1)!;
    element.title = element.textContent;
    if (element instanceof HTMLButtonElement) element.onclick = () => { scopes = scopes.slice(0, index + 1); showScope(); };
    return element;
  }));
  const scope = design.scopes.find(item => item.id === scopes.at(-1))!;
  const ids = new Set(scope.signalIds);
  void schematic.show(scope, design.signals.filter(signal => ids.has(signal.id)));
  refreshCriticalPath();
}

function refreshCriticalPath() {
  const toggle = button('critical-path');
  const label = el('critical-delay');
  toggle.disabled = !design;
  label.hidden = !design || toggle.getAttribute('aria-pressed') !== 'true';
  const scope = design?.scopes.find(item => item.id === scopes.at(-1));
  if (!design || !scope || label.hidden) { schematic.setCriticalPath(); return; }
  const result = criticalPath(design, scope, cellDelays);
  if ('path' in result) {
    const { ticks, steps } = result.path;
    const ps = ticks * stepPs;
    label.textContent = '关键路径 · ' + (ps >= 1000 ? ps / 1000 + ' ns' : ps + ' ps');
    label.title = ticks + ' 个仿真间隔\n' + steps.join(' → ');
    schematic.setCriticalPath(result.path);
  } else {
    label.textContent = label.title = result.message;
    schematic.setCriticalPath();
  }
}

function bindWorker() {
  worker.onmessage = ({ data }: MessageEvent<Frame>) => {
    if (data.version !== version) return;
    pendingFrame = data;
    if (framePaint) return;
    framePaint = requestAnimationFrame(() => {
      framePaint = 0;
      if (!pendingFrame || pendingFrame.version !== version) return;
      frame = pendingFrame;
      pendingFrame = undefined;
      if (frame.error) { stop(); simulationError = frame.error; status(frame.error, true); }
      draw();
    });
  };
  worker.onerror = event => {
    stop();
    simulationError = event.message || '仿真进程异常，请重新综合。';
    status(simulationError, true);
  };
}

function request(mutation?: Request['mutation']) {
  if (!design) return;
  const data: Request = { version: ++version, mutation, view: {
    cursor, start: viewStart, end: viewEnd(), watched: watchedSignals().map(({ id, bits }) => ({ id, bits })),
  } };
  worker.postMessage(data);
}
function traceFrame(source: WaveTrace, signals: Signal[]): Frame {
  const values: Vector = [];
  const waves: Frame['waves'] = {};
  for (const signal of signals) {
    const changes = source.waves[signal.id];
    const unknown: Vector = Array.from({ length: signal.width }, () => 'x');
    const current = changes[changeAt(changes, cursor)]?.value ?? unknown;
    for (const [index, bit] of signal.bits!.entries()) values[bit as number] = current[index];
    const first = changeAt(changes, viewStart);
    const last = changeAt(changes, viewEnd());
    waves[signal.id] = [
      { time: viewStart, value: changes[first]?.value ?? unknown },
      ...changes.slice(first + 1, last + 1),
    ];
  }
  return { version, cursor, computed: source.end, waveEnd: source.end, values, waves };
}
function loadTestbench(result?: TestbenchResult) {
  if (!result) { status('正在运行 Icarus Verilog…'); return; }
  el('log').textContent = result.log;
  if (!result.trace) {
    status('Testbench 运行失败，请查看日志。', true);
    selectWorkbenchTab(button('view-log'));
    return;
  }
  const prefix = result.trace.signals[0].name.split('.')[0] + '.';
  const sharedRoot = result.trace.signals.every(signal => signal.name.startsWith(prefix));
  trace = { ...result.trace, signals: sharedRoot
    ? result.trace.signals.map(signal => ({ ...signal, name: signal.name.slice(prefix.length) }))
    : result.trace.signals };
  stepPs = trace.stepPs;
  viewSpan = end = Math.max(1, trace.end);
  cursor = viewStart = 0;
  const rootDepth = Math.min(...trace.signals.map(signal => signal.name.split('.').length));
  watched = new Set(trace.signals.filter(signal => signal.name.split('.').length === rootDepth).slice(0, 16).map(signal => signal.id));
  el('net-status').textContent = 'Icarus Verilog · VCD';
  selectWorkbenchTab(button('view-wave'));
  draw();
  status(`Testbench 运行完成 · ${trace.signals.length} 个信号`);
}
function draw() {
  const signals = watchedSignals();
  const displayFrame = trace ? traceFrame(trace, signals) : frame;
  const displayCursor = displayFrame?.cursor ?? cursor;
  const values = frame?.values ?? [];
  schematic.update(values, palette, radixFor, chipType);
  waveform.update({ signals, start: viewStart, end: viewEnd(), cursor: displayCursor, stepPs, frame: displayFrame, palette, radixFor });
  el('time-readout').textContent = `${nsAt(displayCursor)} / ${nsAt(end)} ns`;
  el('preview').textContent = trace ? `VCD · ${nsAt(trace.end)} ns` : !design ? '' : simulationError ? '仿真不可用' : (frame?.computed ?? -1) < viewEnd()
    ? `预览计算中 · ${Math.max(0, nsAt(frame?.computed ?? 0))} ns`
    : `已计算至 ${nsAt(Math.min(end, frame!.computed))} ns`;
  for (const name of ['step', 'cycle', 'play', 'rewind']) button(name).disabled = !design || !!simulationError;
  button('step').disabled ||= playing;
  button('cycle').disabled ||= playing;
}

function setView(start: number, span: number) {
  const nextSpan = Math.max(1, Math.min(end, Math.round(span)));
  const nextStart = Math.max(0, Math.min(end - nextSpan, Math.round(start)));
  if (nextSpan === viewSpan && nextStart === viewStart) return;
  viewSpan = nextSpan;
  viewStart = nextStart;
  draw();
  request();
}
function panWave(start: number, span: number) {
  button('follow').setAttribute('aria-pressed', 'false');
  setView(start, span);
}
function zoomWave(scale: number, anchor?: number) {
  const focal = anchor ?? (cursor >= viewStart && cursor <= viewEnd() ? cursor : Math.round((viewStart + viewEnd()) / 2));
  const next = Math.max(1, Math.min(end, Math.round(viewSpan * scale)));
  if (next !== viewSpan) setView(focal - (focal - viewStart) * next / viewSpan, next);
}
function focusCursor() {
  if (button('follow').getAttribute('aria-pressed') !== 'true' || (cursor >= viewStart && cursor < viewEnd())) return;
  viewStart = Math.max(0, Math.min(end - viewSpan, cursor - Math.floor(viewSpan * .2)));
}
function seek(time: number) {
  cursor = Math.max(0, Math.min(end, time));
  focusCursor();
  if (trace) draw();
  else request();
}
function stop() {
  playing = false;
  clearInterval(playTimer);
  button('play').classList.remove('playing');
  el('play-label').textContent = '运行';
  button('step').disabled = !design || !!simulationError;
  button('cycle').disabled = !design || !!simulationError;
}
function toggleRun() {
  if (playing) { stop(); return; }
  if (!design || simulationError) return;
  if (cursor >= end) seek(0);
  playing = true;
  button('play').classList.add('playing');
  el('play-label').textContent = '暂停';
  button('step').disabled = true;
  button('cycle').disabled = true;
  let last = performance.now();
  let accruedPs = 0;
  playTimer = setInterval(() => {
    const now = performance.now();
    accruedPs += (now - last) * playbackNsPerSecond;
    last = now;
    if (frame?.cursor !== cursor || frame.computed < cursor) return;
    if (cursor >= end) { stop(); return; }
    const ticks = Math.floor(accruedPs / stepPs);
    if (ticks) {
      accruedPs -= ticks * stepPs;
      seek(cursor + ticks);
    }
  }, 30);
}

function shownValue(signal: Signal, time: number) {
  if (!frame || frame.computed < time) return undefined;
  const bits = signal.bits ?? [];
  if (frame.cursor === time && (frame.values.length || bits.every(bit => typeof bit !== 'number'))) {
    return bits.map(bit => typeof bit === 'number' ? frame!.values[bit] : bit);
  }
  if (time > frame.waveEnd) return undefined;
  return frame.waves[signal.id]?.findLast(change => change.time <= time)?.value;
}
function submitEdit(signal: Signal, time: number, value: Vector, duration: Duration) {
  const start = duration === 'period' ? time - time % period : time;
  cursor = Math.min(cursor, start);
  focusCursor();
  simulationError = '';
  request({ type: 'edit', id: signal.id, time, value, duration });
  status(`已更新 ${signal.name} · 从 ${nsAt(start)} ns 重算预览`);
}
function handlePart(part: Part, alternate: boolean) {
  if (part.child) { scopes.push(part.child); showScope(); return; }
  const signal = design?.signals.find(item => item.id === part.signal);
  if (!signal?.editable || simulationError) return;
  if (signal.clock) { showClock(signal); return; }
  const time = cursor;
  const value = shownValue(signal, time);
  if (signal.width === 1 && !alternate && value) submitEdit(signal, time, [value[0] === '1' ? '0' : '1'], 'end');
  else showValue(signal, time, 'end', true, value);
}
function handleWave(time: number, signal?: Signal, alternate = false) {
  if ((!design && !trace) || simulationError || playing) return;
  if (!alternate) { seek(time); return; }
  if (!signal?.editable || signal.clock) return;
  const duration = select('duration').value as Duration;
  showValue(signal, time, duration, false, shownValue(signal, time));
}

let editing: { signal: Signal; time: number; diagram: boolean; changedRadix: boolean } | undefined;
let valueBase: Radix = 'bin';
function showValue(signal: Signal, time: number, duration: Duration, diagram: boolean, value?: Vector) {
  editing = { signal, time, diagram, changedRadix: false };
  el('value-title').textContent = signal.name + ' · ' + signal.width + ' bit';
  el('value-time').textContent = nsAt(time) + ' ns' + (diagram ? ' · 生效至结束' : '');
  el('value-duration-label').hidden = diagram;
  select('value-duration').value = duration;
  valueBase = radixFor(signal);
  if (value?.some(bit => bit === 'x' || bit === 'z')) valueBase = 'bin';
  const radix = select('value-radix');
  radix.querySelector<HTMLOptionElement>('[value="real"]')!.disabled = signal.width !== 32 && signal.width !== 64;
  radix.value = valueBase;
  input('value-input').value = value ? formatValue(value, valueBase) : '';
  el('value-error').textContent = '';
  dialog('value-dialog').showModal();
  input('value-input').focus();
  input('value-input').select();
}
on('value-radix', 'change', () => {
  if (!editing) return;
  const next = select('value-radix').value as Radix;
  editing.changedRadix = true;
  try {
    const value = parseValue(input('value-input').value, editing.signal.width, valueBase);
    input('value-input').value = formatValue(value, next);
  } catch { /* Keep unfinished input while selecting a new radix. */ }
  valueBase = next;
});
el<HTMLFormElement>('value-form').onsubmit = event => {
  event.preventDefault();
  if (!editing) return;
  try {
    const { signal, time, diagram } = editing;
    const value = parseValue(input('value-input').value, signal.width, valueBase);
    if (editing.changedRadix) setDisplayRadix(signal, valueBase);
    const duration = diagram ? 'end' : select('value-duration').value as Duration;
    submitEdit(signal, time, value, duration);
    dialog('value-dialog').close();
  } catch (error) { el('value-error').textContent = (error as Error).message; }
};

let clockTarget: Signal | undefined;
function showClock(signal: Signal) {
  clockTarget = signal;
  el('clock-title').textContent = signal.name + ' · 时钟输入';
  const ticks = clockOverrides.get(signal.id);
  input('clock-period').value = ticks === undefined ? '' : String(nsAt(ticks));
  el('clock-error').textContent = '';
  dialog('clock-dialog').showModal();
}
el<HTMLFormElement>('clock-form').onsubmit = event => {
  event.preventDefault();
  if (!clockTarget) return;
  const value = input('clock-period').value === '' ? undefined : Math.round(input('clock-period').valueAsNumber * 1000) / stepPs;
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 2 || value % 2)) {
    el('clock-error').textContent = '时钟周期应为仿真间隔的正偶数倍。';
    return;
  }
  if (value === undefined) clockOverrides.delete(clockTarget.id);
  else clockOverrides.set(clockTarget.id, value);
  simulationError = '';
  request({ type: 'clock', id: clockTarget.id, period: value });
  status('已更新时钟，从 0 ns 重算预览。');
  dialog('clock-dialog').close();
};

function renderPalette() {
  const names = { '0': '0 · 低电平', '1': '1 · 高电平', x: 'X · 不确定', z: 'Z · 高阻' };
  const entries = Object.entries(palette) as [Logic, string][];
  el('legend').replaceChildren(...entries.map(([state, color]) => {
    const key = document.createElement('span');
    const dot = document.createElement('i');
    dot.className = 'legend-dot'; dot.style.backgroundColor = color;
    key.append(dot, names[state]);
    return key;
  }));
}
const componentColors = [
  ['input', '输入（含时钟）', '#5b8fb2', '#1b374d'], ['output', '输出', '#bb8b56', '#4a3220'],
  ['inout', '双向端口', '#5c9c90', '#203d38'], ['other', '其他元件', '#445368', '#1c2633'],
];
function diagramColorControl(variable: string, name: string, initial: string) {
  const label = document.createElement('label');
  const control = document.createElement('input');
  control.type = 'color';
  let saved: string | null = null;
  try { saved = localStorage.getItem(variable); } catch { /* Use the session color. */ }
  control.value = saved ?? initial;
  if (variable !== '--diagram-background' || saved !== null) {
    document.documentElement.style.setProperty(variable, control.value);
  }
  control.oninput = () => {
    document.documentElement.style.setProperty(variable, control.value);
    try { localStorage.setItem(variable, control.value); } catch { /* Keep the session color. */ }
  };
  label.append(name, control);
  return label;
}
const componentControls = componentColors.flatMap(([kind, name, stroke, fill]) => [
  diagramColorControl('--' + kind + '-stroke', name + '边框', stroke),
  diagramColorControl('--' + kind + '-fill', name + '填充', fill),
]);
componentControls.push(
  diagramColorControl('--bus-outline', '总线边框', '#d4dbea'),
  diagramColorControl('--critical-color', '关键路径', '#ff73b5'),
  diagramColorControl('--diagram-background', '画布背景', '#121820'),
);
function showPalette() {
  if (!document.documentElement.style.getPropertyValue('--diagram-background')) {
    const background = getComputedStyle(el('schematic')).backgroundColor.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    const control = componentControls.at(-1)?.querySelector('input');
    if (control && background) {
      control.value = '#' + background.slice(1).map(channel => Number(channel).toString(16).padStart(2, '0')).join('');
    }
  }
  el('color-controls').replaceChildren(...(Object.keys(palette) as Logic[]).map(state => {
    const label = document.createElement('label');
    const control = document.createElement('input');
    control.type = 'color'; control.value = palette[state];
    control.oninput = () => {
      palette[state] = customPalette[state] = control.value;
      try { localStorage.setItem('verilog-palette', JSON.stringify(customPalette)); } catch { /* Session palette remains available. */ }
      renderPalette(); draw();
    };
    label.append(state.toUpperCase(), control);
    return label;
  }));
  el('color-controls').append(...componentControls);
  dialog('color-dialog').showModal();
}

function split(id: string, variable: string, measure: (event: PointerEvent) => number) {
  const bar = el(id);
  bar.onpointerdown = event => { bar.setPointerCapture(event.pointerId); };
  bar.onpointermove = event => {
    if (bar.hasPointerCapture(event.pointerId)) document.documentElement.style.setProperty(variable, measure(event) + 'px');
  };
}

bindWorker();
const optionHints: Record<string, string> = {
  'mode-rtl': 'RTL 执行 proc、memory_map，可选 opt -keepdc。',
  'mode-gate': '门级执行 proc 和 synth。',
  standard: 'read_slang --std <标准>；实时检查使用 slang --std <标准>。',
  top: '指定时执行 read_slang --top <模块名>；随后执行 hierarchy -check -auto-top。',
  hierarchy: '勾选时给 read_slang 添加 --best-effort-hierarchy。',
  optimize: 'RTL 模式在 memory_map 后执行 opt -keepdc。',
  observe: '执行 setattr -set keep 1 w:*；门级同时给 synth 添加 -nofsm。',
  abc: '门级勾选时执行 scratchpad -set abc.nocleanup 1 并启用 synth 内置 ABC；取消时执行 synth -noabc。',
  'live-lint': '编辑后独立执行 slang -F inputs.f。命令文件传入 --lint-only、语言标准和包含路径。',
  includes: '向 read_slang 和 slang 的 inputs.f 添加 -I <目录>。',
  defines: '向 read_slang 和 slang 的 inputs.f 添加 -D <宏定义>。',
  parameters: '向 read_slang 的 inputs.f 添加 -G <参数>=<值>。',
  'extra-commands': '在默认综合流程之后、write_json design.json 之前逐行执行，例如 opt_clean -purge。',
};
for (const [id, hint] of Object.entries(optionHints)) {
  el(id).title = hint;
  const label = el(id).closest('label');
  if (label) label.title = hint;
}
on('settings', 'click', () => {
  const form = el<HTMLFormElement>('settings-form');
  const settingsBefore = JSON.stringify(options());
  const checked = input('live-lint').checked;
  const values = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')]
    .map(control => ({ control, value: control.value, checked: control instanceof HTMLInputElement && control.checked }));
  const panel = dialog('settings-dialog');
  panel.returnValue = '';
  form.onsubmit = event => {
    if ((event.submitter as HTMLButtonElement)?.value === 'apply'
      && (settingsBefore !== JSON.stringify(options()) || checked !== input('live-lint').checked)) inputsChanged();
  };
  panel.addEventListener('close', () => {
    if (panel.returnValue !== 'apply') for (const saved of values) {
      saved.control.value = saved.value;
      if (saved.control instanceof HTMLInputElement) saved.control.checked = saved.checked;
    }
  }, { once: true });
  panel.showModal();
});
on('add-include', 'click', () => { void (async () => {
  const path = await workbench.directory();
  if (path) el<HTMLTextAreaElement>('includes').value = [...lines('includes'), path].join('\n');
})(); });
function setModeTab(mode: BuildOptions['mode']) {
  const focusTab = document.activeElement?.closest('.mode-tabs');
  selectedMode = mode;
  for (const level of modes) {
    const tab = button('mode-' + level);
    tab.setAttribute('aria-selected', String(level === mode));
    tab.tabIndex = level === mode ? 0 : -1;
  }
  el('schematic').setAttribute('aria-labelledby', 'mode-' + mode);
  if (focusTab) button('mode-' + mode).focus();
}
for (const mode of modes) {
  const tab = button('mode-' + mode);
  tab.onclick = () => {
    if (selectedMode === mode) return;
    setModeTab(mode);
    void synthesize();
  };
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 'rtl' : event.key === 'End' ? 'gate' : modes.find(level => level !== mode)!;
    button('mode-' + target).click();
  };
}
on('synthesize', 'click', () => { void synthesize(); });
on('show-signals', 'click', () => { inspector = 'signals'; renderInspector(); });
on('show-parts', 'click', () => { inspector = 'parts'; renderInspector(); });
on('signal-filter', 'input', renderInspector);
on('wave-signal-filter', 'input', renderWaveSignalPicker);
on('rewind', 'click', () => { stop(); seek(0); });
on('step', 'click', () => seek(cursor + 1));
on('cycle', 'click', () => seek(cursor + period));
on('play', 'click', toggleRun);
on('diagram-in', 'click', () => schematic.scale(1.25));
on('diagram-out', 'click', () => schematic.scale(.8));
on('diagram-fit', 'click', () => schematic.fit());
on('critical-path', 'click', () => {
  const toggle = button('critical-path');
  toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'));
  refreshCriticalPath();
});
on('wave-in', 'click', () => zoomWave(.5));
on('wave-out', 'click', () => zoomWave(2));
on('wave-fit', 'click', () => setView(0, end));
document.addEventListener('keydown', event => {
  if ((event.code !== 'Space' && event.key !== ' ') || event.defaultPrevented || event.isComposing ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      !el('wave-view').getClientRects().length || document.querySelector('dialog[open]')) return;
  const control = event.target instanceof Element
    ? event.target.closest('button, input, select, textarea, [contenteditable]') : null;
  if (control && control.id !== 'view-wave' && !control.closest('.wave-actions')) return;
  event.preventDefault();
  setView(0, end);
});
on('follow', 'click', () => {
  const toggle = button('follow');
  toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'));
  focusCursor();
  if (trace) draw();
  else request();
});
function changeAllDelays(zero: boolean) {
  if (!design) return;
  stop();
  cellDelays.clear();
  if (zero) for (const { type } of design.cells) cellDelays.set(type, 0);
  refreshCriticalPath();
  frame = undefined;
  simulationError = '';
  request({ type: 'delays', values: Object.fromEntries(cellDelays) });
  renderInspector();
  draw();
  status(zero ? '所有元件延迟已清零，正在重新计算。' : '已恢复元件的默认相对延迟，正在重新计算。');
}
on('zero-delays', 'click', () => changeAllDelays(true));
on('reset-delays', 'click', () => changeAllDelays(false));
on('colors', 'click', showPalette);
on('value-cancel', 'click', () => dialog('value-dialog').close());
on('clock-cancel', 'click', () => dialog('clock-dialog').close());
const timingForm = el<HTMLFormElement>('timing');
let timingTimer: ReturnType<typeof setTimeout> | undefined;
function applyTiming() {
  clearTimeout(timingTimer);
  const invalid = timingForm.querySelector<HTMLInputElement>('input:invalid');
  const step = input('step-size').valueAsNumber;
  const nextEnd = Math.round(input('end').valueAsNumber * 1000) / step;
  const nextPeriod = Math.round(input('period').valueAsNumber * 1000) / step;
  let error = '';
  if (invalid) error = (invalid.labels?.[0]?.textContent?.trim() ?? '') + '：' + invalid.validationMessage;
  else if (!Number.isSafeInteger(nextPeriod) || nextPeriod < 2 || nextPeriod % 2) error = '时钟周期应为仿真间隔的正偶数倍。';
  else if (!Number.isSafeInteger(nextEnd) || nextEnd < 1 || nextEnd > 100_000) error = '结束时间应为仿真间隔的整数倍，范围为 1 至 100,000 个间隔。';
  if (error) {
    timingForm.dataset.error = error;
    status(error, true);
    return;
  }
  const previousError = timingForm.dataset.error;
  delete timingForm.dataset.error;
  if (step === stepPs && nextPeriod === period && nextEnd === end) {
    if (previousError && el('status').textContent === previousError) status('时间设置已生效。');
    return;
  }
  stop();
  const resetInputs = stepPs !== step;
  stepPs = step; period = nextPeriod; end = nextEnd;
  refreshCriticalPath();
  if (resetInputs) { cursor = 0; clockOverrides.clear(); }
  cursor = Math.min(cursor, end);
  viewStart = 0; viewSpan = end;
  frame = undefined; simulationError = '';
  draw();
  request({ type: 'timing', timing: simTiming(), resetInputs });
  status(resetInputs ? '仿真间隔已变更，输入激励已重置。' : '已更新时间设置。');
}
// Let multi-digit edits settle before rescaling time and resetting the stimulus.
timingForm.oninput = () => {
  clearTimeout(timingTimer);
  timingTimer = setTimeout(applyTiming, 450);
};
timingForm.onchange = applyTiming;
timingForm.onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); applyTiming(); }
};
timingForm.onsubmit = event => { event.preventDefault(); applyTiming(); };

split('inspect-split', '--inspect-width', event => Math.max(174, Math.min(innerWidth - 580, innerWidth - event.clientX - 9)));
bindWorkbenchTabs();
new MutationObserver(() => {
  palette = themedPalette();
  renderPalette();
  renderInspector();
  draw();
}).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
workbench.connect((sources, build) => {
  hostSources = sources;
  inputsChanged();
  if (build) void synthesize();
}, loadTestbench);
renderPalette();
renderInspector();
draw();
queueLint();
