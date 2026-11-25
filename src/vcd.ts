import { parseValue } from './design';
import type { Signal, Vector } from './design';
import type { Change } from './simulation';

export interface WaveTrace {
  stepPs: number;
  end: number;
  signals: Signal[];
  waves: Record<string, Change<Vector>[]>;
}

const units: Record<string, number> = { s: 1e12, ms: 1e9, us: 1e6, ns: 1000, ps: 1, fs: .001 };

export function parseVcd(text: string): WaveTrace {
  const tokens: string[] = text.match(/\S+/g) ?? [];
  const scopes: string[] = [];
  const signals: Signal[] = [];
  const waves: WaveTrace['waves'] = Object.create(null);
  const codes = new Map<string, string[]>();
  let stepPs = 0;
  let time = 0;
  let bit = 0;
  let index = 0;
  function argument() {
    const end = tokens.indexOf('$end', index);
    if (end < 0) throw new Error('VCD 定义缺少 $end。');
    const args = tokens.slice(index, end);
    index = end + 1;
    return args;
  }

  let definitionsEnded = false;
  while (index < tokens.length && !definitionsEnded) {
    const command = tokens[index++];
    const args = argument();
    switch (command) {
      case '$scope': scopes.push(args[1]); break;
      case '$upscope': scopes.pop(); break;
      case '$timescale': {
        const scale = /^(1|10|100)(s|ms|us|ns|ps|fs)$/.exec(args.join(''));
        if (!scale) throw new Error('VCD 时间单位无效。');
        stepPs = Number(scale[1]) * units[scale[2]];
        break;
      }
      case '$var': {
        const [type, rawWidth, code, name] = args;
        const real = type === 'real' || type === 'realtime';
        const width = real ? 64 : Number(rawWidth);
        if (type === 'string' || type === 'event') break;
        if (!code || !name || !Number.isInteger(width) || width < 1 || width > 4096) throw new Error('VCD 信号定义无效。');
        if (bit + width > 200_000 || signals.length >= 5000) throw new Error('VCD 包含过多信号。');
        const id = String(signals.length);
        const series = codes.get(code) ?? [];
        series.push(id);
        codes.set(code, series);
        waves[id] = [];
        signals.push({ id, name: [...scopes, name].join('.'), width,
          bits: Array.from({ length: width }, () => bit++),
          clock: /^(clk|clock)$/i.test(name), editable: false, signed: false, real });
        break;
      }
      case '$enddefinitions': definitionsEnded = true; break;
    }
  }
  if (!definitionsEnded || !stepPs || !signals.length) throw new Error('VCD 缺少时间单位或可显示的信号。');

  let changes = 0;
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token[0] === '#') {
      const next = Number(token.slice(1));
      if (!Number.isSafeInteger(next) || next < time) throw new Error('VCD 时间戳无效。');
      time = next;
      continue;
    }
    if (token === '$comment') { argument(); continue; }
    if (token[0] === '$') continue;
    const prefix = token[0].toLowerCase();
    const vector = prefix === 'b';
    const real = prefix === 'r';
    if (prefix === 's') { ++index; continue; }
    const raw = vector || real ? token.slice(1).toLowerCase() : prefix;
    const code = vector || real ? tokens[index++] : token.slice(1);
    const ids = codes.get(code);
    if (!ids || (!real && !/^[01xz]+$/.test(raw))) continue;
    for (const id of ids) {
      const signal = signals[Number(id)];
      if (real !== !!signal.real) continue;
      const { width } = signal;
      const fill = raw[0] === 'x' || raw[0] === 'z' ? raw[0] : '0';
      const value = real ? parseValue(raw, width, 'real') : [...raw.slice(-width).padStart(width, fill)].reverse() as Vector;
      const series = waves[id];
      if (series.at(-1)?.time === time) series[series.length - 1] = { time, value };
      else {
        changes += width;
        if (changes > 8_000_000) throw new Error('VCD 波形数据超过显示上限。');
        series.push({ time, value });
      }
    }
  }
  return { stepPs, end: time, signals, waves };
}

export function changeAt(changes: readonly Change<Vector>[], time: number): number {
  let low = 0;
  let high = changes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (changes[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
