import { changeAt } from './vcd';
import type { WaveTrace } from './vcd';
import type { TestbenchResult } from './testbench';
import { workbench } from '../vscode/src/web-platform';
import './style.css';
import { compile, radixShort } from './design';
import type { Design, Logic, Part, Radix, Scope, Signal, Vector } from './design';
import { testbenchSimulatorLabels } from './protocol';
import type { TestbenchSimulator, BuildOptions, BuildResult, Diagnostic, FpgaClockTiming, FpgaCriticalPath, Source, TargetPlatform } from './protocol';
import { Schematic, defaultPalette } from './schematic';
import type { Palette } from './schematic';
import type { Frame, Request } from './sim-worker';
import { defaultDelay } from './simulation';
import { criticalPath } from './critical-path';
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
let staBusy = false;
let fpgaBusy = false;
let jtagBusy = false;
let bitstreamRevision: number | undefined;

function disableBuildButtons(disabled: boolean) {
  select('target-platform').disabled = disabled;
  for (const id of ['synthesize', 'run-sta', 'build-bitstream', 'detect-jlink']) button(id).disabled = disabled;
  button('program-jlink').disabled = disabled || bitstreamRevision !== revision;
}
let synthesisQueued = false;
let logMode: 'lint' | 'synth' = 'lint';
let design: Design | undefined;
let trace: WaveTrace | undefined;
const testbenchView = document.body.classList.contains('testbench-view');
let scopes: string[] = [];
let dutOverview: Scope | undefined;
const inDutOverview = () => dutOverview?.id === scopes.at(-1) && !!dutOverview;
let watched = new Set<string>();
const probes = new Map<string, Signal>();
const displayRadices = new Map<string, Radix>();
let chipType = '';
let inspector: 'signals' | 'parts' = 'signals';
let selectedSignalId: string | undefined;
const lightPalette: Palette = { '0': '#456e8d', '1': '#168052', x: '#985a0a', z: '#7545a1' };
function themedPalette(): Palette {
  return document.body.classList.contains('vscode-light') ? lightPalette : defaultPalette;
}
const cellDelays = new Map<string, number>();
let palette = themedPalette();

const worker = workbench.worker('sim-worker');
let version = 0;
let frame: Frame | undefined;
let pendingFrame: Frame | undefined;
let framePaint = 0;
let simulationError = '';
let cursor = 0;
let viewStart = 0;
const diagramStepPs = 50;
let stepPs = diagramStepPs;
const period = 20;
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
  (signal, x, y, aliases) => signalMenu(signal, x, y, aliases),
  () => workbench.worker('layout-worker'),
  workbench.elkWorkerUrl,
  testbenchView,
);
const waveform = new Waveform(el('wave'), el('wave-scroll'), handleWave, zoomWave,
  (start, finish) => setView(start, finish - start), setView, openRadixMenu, signal => {
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
function openRadixMenu(signal: Signal, x: number, y: number) { signalMenu(signal, x, y); }

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

function signalMenu(signal: Signal, x: number, y: number, aliases?: Signal[]) {
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
    variable.onchange = () => signalMenu(aliases.find(s => s.id === variable.value)!, x, y, aliases);
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
  button('program-jlink').disabled = true;
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

function beginSynthesisProgress() {
  const bar = el('synthesis-progress');
  const stage = el('synthesis-stage');
  const time = el('synthesis-elapsed');
  const started = performance.now();
  const refresh = () => { time.textContent = `已用 ${((performance.now() - started) / 1000).toFixed(1)} s`; };
  stage.textContent = '正在准备综合…';
  refresh();
  bar.hidden = false;
  const timer = setInterval(refresh, 200);
  return {
    update: (label: string) => { stage.textContent = label; },
    finish: () => { clearInterval(timer); bar.hidden = true; },
  };
}

async function synthesize() {
  if (!hostSources.length || staBusy || fpgaBusy || jtagBusy) return;
  if (synthesisBusy) { synthesisQueued = true; return; }
  const currentOptions = options();
  const started = revision;
  synthesisBusy = true;
  disableBuildButtons(true);
  el('schematic').setAttribute('aria-busy', 'true');
  ++jobSequence;
  logMode = 'synth';
  status('正在综合…');
  const progress = beginSynthesisProgress();
  try {
    const result = await workbench.hdl(currentOptions, false, stage =>
      progress.update(stage === 'synthesis' ? 'Yosys 正在综合…' : '正在读取网表…'));
    if (synthesisQueued) return;
    if (started !== revision) { status('综合期间源码或设置已修改，请重新综合。'); return; }
    el('log').textContent = result.log;
    if (result.diagnostics.length) applyDiagnostics(result.diagnostics);
    if (!result.ok || !result.netlist || !result.top) {
      selectWorkbenchTab(button('view-log'));
      status('综合失败，请查看诊断与日志。', true);
      return;
    }
    progress.update('正在构建电路模型…');
    const nextDesign = compile(result.netlist, result.top, result.sourceNetlist);
    const sameTop = nextDesign.root === design?.root && !simulationError;
    stop();
    design = nextDesign;
    if (!sameTop) selectedSignalId = undefined;
    schematic.highlightSignal(nextDesign.signals.find(signal => signal.id === selectedSignalId));
    for (const id of probes.keys()) displayRadices.delete(id);
    probes.clear();
    buildRevision = revision;
    builtMode = currentOptions.mode;
    scopes = [design.root];
    if (sameTop) watched = new Set([...watched].filter(id => nextDesign.signals.some(signal => signal.id === id && signal.bits)));
    else {
      watched = new Set(design.signals.filter(signal => signal.direction && (signal.editable || !signal.name.includes('.'))).slice(0, 16).map(signal => signal.id));
      cursor = viewStart = 0; viewSpan = end;
      cellDelays.clear();
      displayRadices.clear();
    }
    frame = undefined;
    chipType = ''; simulationError = '';
    el('net-status').textContent = result.top + (builtMode === 'gate' ? ' · 门级' : ' · RTL');
    progress.update('正在布局和布线…');
    ++version;
    const layout = showScope(true);
    const laidOut = await layout;
    refreshCriticalPath();
    renderInspector();
    draw();
    request({ type: 'load', design, timing: simTiming() });
    if (started !== revision) status('源码或设置已变更，请重新综合。');
    else if (!laidOut) status('网表已生成，电路图布局未完成。', true);
    else status(`综合完成 · ${design.cells.length} 个元件`);
  } catch (error) {
    if (synthesisQueued) return;
    selectWorkbenchTab(button('view-log'));
    status(String(error), true);
  } finally {
    progress.finish();
    synthesisBusy = false;
    if (synthesisQueued) {
      synthesisQueued = false;
      void synthesize();
    } else {
      if (builtMode && selectedMode !== builtMode) setModeTab(builtMode);
      disableBuildButtons(false);
      el('schematic').setAttribute('aria-busy', 'false');
    }
  }
}

function showStaLog(log: string) {
  el('sta-log').textContent = log;
  el('sta-log-details').hidden = false;
  el('sta-show-log').hidden = false;
}

function setStaMetric(id: string, slack: number | undefined, unit: string) {
  const field = el(id);
  const violated = slack !== undefined && (slack < 0 || Object.is(slack, -0));
  field.textContent = slack === undefined ? '无可报告路径'
    : `${violated && Object.is(slack, -0) ? '-0.000' : slack.toFixed(3)} ${unit} · ${violated ? 'VIOLATED' : 'MET'}`;
  field.classList.toggle('error', violated);
}

function formatFpgaPaths(paths: FpgaCriticalPath[], clocks: FpgaClockTiming) {
  const separator = '-----------------------------------------------------------';
  const row = (delay: number | undefined, time: number, description: string) =>
    (delay === undefined ? '        ' : delay.toFixed(3).padStart(8)) + time.toFixed(3).padStart(9) + '   ' + description;
  const sections = paths.filter(({ path }) => path.length).map(({ from, to, path }) => {
    const first = path[0].from;
    const last = path.at(-1)!.to;
    const clock = from === to ? /^(?:posedge|negedge) (.+)$/.exec(from)?.[1] : undefined;
    const frequency = clock ? clocks[clock]?.constraint : undefined;
    const period = frequency !== undefined && Number.isFinite(frequency) && frequency > 0 ? 1000 / frequency : undefined;
    let arrival = 0;
    let setup = 0;
    const delays: string[] = [];
    for (const step of path) {
      if (step.type === 'setup') {
        setup += step.delay;
      } else {
        arrival += step.delay;
        delays.push(row(step.delay, arrival, `${step.type} ${step.to.cell}/${step.to.port}${step.net ? ' · ' + step.net : ''}`));
      }
    }
    const required = period === undefined ? undefined : period - setup;
    const slack = required === undefined ? undefined : required - arrival;
    const report = [
      `Startpoint: ${first.cell}/${first.port} (${from})`,
      `Endpoint: ${last.cell}/${last.port} (${to})`,
      `Path Group: ${clock ?? from + ' → ' + to}`,
      'Path Type: max', '', '   Delay     Time   Description (ns)', separator, ...delays,
      row(undefined, arrival, 'data arrival time'),
    ];
    if (period !== undefined && required !== undefined && slack !== undefined) {
      report.push('', row(period, period, 'clock period'), row(-setup, required, 'FPGA setup time'),
        row(undefined, required, 'data required time'), separator,
        row(undefined, slack, `slack (${slack >= 0 ? 'MET' : 'VIOLATED'})`));
    } else {
      if (setup) report.push(row(setup, arrival + setup, 'path delay including FPGA setup time'));
      report.push('', '此路径未提供可用于计算 slack 的同沿时钟周期。');
    }
    return { report: report.join('\n'), slack };
  });
  sections.sort((a, b) => (a.slack ?? Infinity) - (b.slack ?? Infinity));
  return 'Setup 最差路径\n' + (sections.map(section => section.report).join('\n\n') || '无可报告的关键路径。') +
    '\n\nHold 最差路径\n此 nextpnr 流程未报告 Hold 路径。';
}

async function runSta() {
  if (!hostSources.length || synthesisBusy || staBusy || fpgaBusy || jtagBusy) return;
  staBusy = true;
  const started = revision;
  const fpga = select('target-platform').value === 'fpga';
  disableBuildButtons(true);
  el('sta-pane').dataset.platform = fpga ? 'fpga' : 'asic';
  el('sta-summary').hidden = true;
  el('fpga-timing-clocks').hidden = true;
  el('sta-inputs').textContent = '';
  el('sta-show-log').hidden = true;
  el('sta-log-details').hidden = true;
  el('sta-report').textContent = '正在准备 STA…';
  selectWorkbenchTab(button('view-sta'));
  status('正在运行 STA…');
  const progress = beginSynthesisProgress();
  progress.update('正在准备 STA…');
  try {
    if (fpga) {
      const result = await workbench.fpgaTiming(options(), stage => {
        const label = stage === 'place-route' ? 'nextpnr 正在布局布线并分析 FPGA 时序…' : 'Yosys 正在综合 FPGA 网表…';
        progress.update(label);
        el('sta-report').textContent = label;
      });
      el('sta-inputs').textContent = [result.top, result.part, result.xdc, 'nextpnr · 布局布线后时序'].filter(Boolean).join(' · ');
      showStaLog(result.log);
      if (!result.ok) {
        el('sta-report').textContent = 'FPGA 时序分析失败。请查看完整 STA 日志。';
        status('FPGA 时序分析失败。', true);
        return;
      }
      const clocks = Object.entries(result.clocks ?? {}).filter(([, { achieved, constraint }]) =>
        Number.isFinite(achieved) && achieved > 0 && Number.isFinite(constraint) && constraint > 0);
      const slack = (achieved: number, constraint: number) => 1000 / constraint - 1000 / achieved;
      const worstSlack = clocks.length ? Math.min(...clocks.map(([, c]) => slack(c.achieved, c.constraint))) : undefined;
      el('sta-setup-label').textContent = 'Setup · WNS（同一时钟域）';
      setStaMetric('sta-setup', worstSlack, 'ns');
      el('sta-hold').textContent = '此 nextpnr 流程未报告';
      el('sta-hold').classList.remove('error');
      el('sta-summary').hidden = false;
      el('sta-report').textContent = formatFpgaPaths(result.paths ?? [], result.clocks ?? {});
      const list = el('fpga-timing-clocks');
      list.replaceChildren(...clocks.map(([name, { achieved, constraint }]) => {
        const item = document.createElement('li');
        const met = achieved >= constraint;
        item.textContent = `${name} · Fmax ${achieved.toFixed(2)} MHz / 目标 ${constraint.toFixed(2)} MHz · Setup slack ${slack(achieved, constraint).toFixed(3)} ns · ${met ? 'MET' : 'VIOLATED'}`;
        item.classList.toggle('error', !met);
        return item;
      }));
      list.hidden = !clocks.length;
      const violated = clocks.some(([, clock]) => clock.achieved < clock.constraint);
      status(started !== revision ? 'FPGA 时序报告基于运行前的源码和设置，请重新运行。'
        : !clocks.length ? 'FPGA 时序报告没有可报告的时钟。'
          : violated ? 'FPGA 时序未满足，请查看关键路径。' : 'FPGA 时序报告已生成。', violated);
      return;
    }
    const result = await workbench.sta(options(), stage => {
      const label = stage === 'sta' ? 'OpenSTA 正在分析…' : stage === 'netlist' ? '正在检查映射网表…' : 'Yosys 正在映射标准单元…';
      progress.update(label);
      el('sta-report').textContent = label;
    });
    if (result.cancelled) {
      el('sta-report').textContent = '未选择 STA 输入文件。点击 Run STA 重新选择，或用「Verilog: 打开 FIFO 示例」试跑内置配置。';
      status('已取消 STA。');
      return;
    }
    el('sta-inputs').textContent = [result.top, result.liberty, result.sdc,
      result.demo ? 'FIFO 示例模型 · ns · 布局布线前' : 'Liberty 时间单位 · 布局布线前'].filter(Boolean).join(' · ');
    showStaLog(result.log);
    if (!result.ok) {
      el('sta-report').textContent = 'OpenSTA 运行失败。请查看完整 STA 日志。';
      status('STA 运行失败。', true);
      return;
    }
    const [, coverage = '', setup = '', hold = ''] = (result.report ?? '').split(/^=== (?:Constraint coverage|Setup .*|Hold .*) ===$/m);
    const unit = coverage.match(/^\s*time\s+1([a-z]+)\s*$/mi)?.[1] ?? (result.demo ? 'ns' : 'Liberty 时间单位');
    const worstSlack = (section: string) => {
      const values = [...section.matchAll(/^\s*([-+]?\d+(?:\.\d+)?)\s+slack \((MET|VIOLATED)\)/gm)]
        .map(match => match[2] === 'VIOLATED' ? -Math.abs(Number(match[1])) : Number(match[1]));
      return values.length ? Math.min(...values) : undefined;
    };
    const setupSlack = worstSlack(setup);
    const holdSlack = worstSlack(hold);
    el('sta-setup-label').textContent = 'Setup · WNS';
    setStaMetric('sta-setup', setupSlack, unit);
    setStaMetric('sta-hold', holdSlack, unit);
    el('sta-summary').hidden = false;
    el('sta-report').textContent = 'Setup 最差路径\n' + setup.trim() + '\n\nHold 最差路径\n' + hold.trim();
    const violated = [setupSlack, holdSlack].some(slack => slack !== undefined && (slack < 0 || Object.is(slack, -0)));
    status(started !== revision ? 'STA 报告基于运行前的源码和设置，请重新运行。'
      : violated ? 'STA 报告已生成，存在时序违例。' : 'STA 报告已生成。', violated);
  } catch (error) {
    showStaLog(String(error));
    el('sta-report').textContent = '时序分析未完成。请查看完整 STA 日志。';
    status('STA 运行失败，请查看日志。', true);
  } finally {
    progress.finish();
    staBusy = false;
    disableBuildButtons(false);
  }
}

async function buildBitstream() {
  if (!hostSources.length || synthesisBusy || staBusy || fpgaBusy || jtagBusy) return;
  fpgaBusy = true;
  bitstreamRevision = undefined;
  el('jtag-report').hidden = true;
  el('jtag-report').textContent = '';
  const started = revision;
  disableBuildButtons(true);
  el('fpga-output').textContent = '';
  el('fpga-report').textContent = '正在准备 FPGA 编译…';
  selectWorkbenchTab(button('view-fpga'));
  status('正在生成 FPGA 比特流…');
  const progress = beginSynthesisProgress();
  progress.update('正在准备 FPGA 编译…');
  try {
    const result = await workbench.fpga(options(), stage => {
      const label = stage === 'place-route' ? 'nextpnr 正在布局布线…'
        : stage === 'bitstream' ? 'openXC7 正在生成比特流…'
          : stage === 'netlist' ? '正在检查 FPGA 网表…' : 'Yosys 正在综合 FPGA 网表…';
      progress.update(label);
      el('fpga-report').textContent = label;
    });
    el('fpga-output').textContent = [result.part, result.top, result.xdc, result.output].filter(Boolean).join(' · ');
    el('fpga-report').textContent = result.log;
    if (!result.output) { status('FPGA 编译失败，请查看报告。', true); return; }
    bitstreamRevision = started;
    status(started === revision ? 'FPGA 比特流已生成。' : '比特流基于运行前的源码和设置，请重新编译。');
  } catch (error) {
    el('fpga-report').textContent = String(error);
    status('FPGA 编译失败，请查看报告。', true);
  } finally {
    progress.finish();
    fpgaBusy = false;
    disableBuildButtons(false);
  }
}

async function runJtag(program: boolean) {
  if (synthesisBusy || staBusy || fpgaBusy || jtagBusy || (program && bitstreamRevision !== revision)) return;
  jtagBusy = true;
  disableBuildButtons(true);
  const report = el('jtag-report');
  report.hidden = false;
  report.textContent = program ? '正在识别目标并下载到 SRAM…' : '正在扫描 JTAG 链…';
  status(report.textContent);
  try {
    const result = await workbench.jtag(program);
    report.textContent = result.log;
    status(result.ok ? (program ? 'FPGA SRAM 下载完成。' : 'JTAG 链扫描完成。') : 'JTAG 操作失败，请查看日志。', !result.ok);
  } catch (error) {
    report.textContent = String(error);
    status('JTAG 操作失败，请查看日志。', true);
  } finally {
    jtagBusy = false;
    disableBuildButtons(false);
  }
}

const workbenchTabs = ['view-diagram', 'view-wave', 'view-sta', 'view-fpga', 'view-log'].map(button);
function selectWorkbenchTab(selected: HTMLButtonElement) {
  for (const tab of workbenchTabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    el(tab.getAttribute('aria-controls')!).hidden = !active;
  }
}
function showTargetPlatform(platform: TargetPlatform) {
  select('target-platform').value = platform;
  const fpga = platform === 'fpga';
  button('run-sta').hidden = testbenchView;
  button('build-bitstream').hidden = !fpga || testbenchView;
  if (el('sta-pane').dataset.platform && el('sta-pane').dataset.platform !== platform) {
    el('sta-summary').hidden = true;
    el('fpga-timing-clocks').hidden = true;
    el('sta-inputs').textContent = '';
    el('sta-show-log').hidden = true;
    el('sta-report').textContent = '点击 Run STA 执行当前目标的时序分析。';
    delete el('sta-pane').dataset.platform;
  }
  button('view-sta').hidden = testbenchView;
  button('view-fpga').hidden = !fpga || testbenchView;
  if (workbenchTabs.some(tab => tab.hidden && tab.getAttribute('aria-selected') === 'true')) {
    selectWorkbenchTab(button(testbenchView ? 'view-wave' : 'view-diagram'));
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
  if (!testbenchView) button('view-wave').hidden = true;
  else {
    button('mode-gate').hidden = true;
    el('schematic').querySelector('.empty')!.textContent = '正在准备被测模块的 RTL 电路图…';
  }
  showTargetPlatform('asic');
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

function selectSignal(signal: Signal, control: HTMLButtonElement) {
  selectedSignalId = selectedSignalId === signal.id ? undefined : signal.id;
  el('signals').querySelector('.signal-control[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
  control.setAttribute('aria-pressed', String(!!selectedSignalId));
  schematic.highlightSignal(selectedSignalId ? signal : undefined);
  if (!selectedSignalId || !design || inDutOverview()) return;
  let scope = design.scopes.find(item => item.signalIds.includes(signal.id));
  if (!scope || scope.id === scopes.at(-1)) return;
  const path: string[] = [];
  while (scope) {
    const childId: string = scope.id;
    path.unshift(childId);
    scope = design.scopes.find(item => item.parts.some(part => part.child === childId));
  }
  scopes = dutOverview ? [dutOverview.id, ...path] : path;
  showScope();
}

function renderInspector() {
  const filter = input('signal-filter').value.trim().toLowerCase();
  const overview = inDutOverview();
  const signals = (design?.signals ?? []).filter(signal =>
    (!overview || dutOverview!.signalIds.includes(signal.id)) && signal.name.toLowerCase().includes(filter));
  if (overview) inspector = 'signals';
  button('show-parts').hidden = overview;
  const partCounts = new Map<string, number>();
  for (const cell of overview ? [] : design?.cells ?? []) partCounts.set(cell.type, (partCounts.get(cell.type) ?? 0) + 1);
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
    control.title = signal.bits ? '高亮信号布线' : '该源码信号在当前网表中不可观察';
    control.setAttribute('aria-pressed', String(selectedSignalId === signal.id));
    const name = document.createElement('span');
    name.className = 'signal-name';
    name.textContent = signal.name;
    const tag = document.createElement('span');
    tag.className = 'tag';
    const kind = signal.clock ? 'clock' : signal.direction;
    if (kind === 'clock' || kind === 'input' || kind === 'output') control.append(signalIcon(kind));
    tag.textContent = `${kind === 'inout' ? '双向 ' : ''}${signal.width}b`;
    control.append(name);
    control.onclick = () => selectSignal(signal, control);
    li.append(control, tag);
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
        if (dutOverview) scopes.unshift(dutOverview.id);
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

function showScope(keepPrevious = false) {
  if (!design) return;
  renderInspector();
  el('scope-path').replaceChildren(...scopes.map((id, index) => {
    const element = document.createElement(index === scopes.length - 1 ? 'span' : 'button');
    element.textContent = id === dutOverview?.id ? 'DUT' : (JSON.parse(id) as string[]).at(-1)!;
    if (id === dutOverview?.id && inDutOverview()) element.textContent += ' · 双击模块查看 RTL';
    element.title = element.textContent;
    if (element instanceof HTMLButtonElement) element.onclick = () => { scopes = scopes.slice(0, index + 1); showScope(); };
    return element;
  }));
  const scope = inDutOverview() ? dutOverview! : design.scopes.find(item => item.id === scopes.at(-1))!;
  const ids = new Set(scope.signalIds);
  const layout = schematic.show(scope, design.signals.filter(signal => ids.has(signal.id)), undefined, keepPrevious);
  if (!keepPrevious) refreshCriticalPath();
  return layout;
}

function refreshCriticalPath() {
  const toggle = button('critical-path');
  const label = el('critical-delay');
  const overview = inDutOverview();
  toggle.hidden = overview;
  toggle.disabled = !design;
  label.hidden = overview || !design || toggle.getAttribute('aria-pressed') !== 'true';
  const scope = design?.scopes.find(item => item.id === scopes.at(-1));
  if (!design || !scope || label.hidden) { schematic.setCriticalPath(); return; }
  const result = criticalPath(design, scope, cellDelays);
  if ('path' in result) {
    const { ticks, steps } = result.path;
    const ps = ticks * diagramStepPs;
    label.textContent = 'Critical Path · ' + (ps >= 1000 ? ps / 1000 + ' ns' : ps + ' ps');
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
  if (!design || testbenchView) return;
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
let traceDiagramSignals: { signal: Signal; dumped: Signal }[] = [];
function linkTraceDiagram(source: WaveTrace, diagram: Design) {
  const byName = new Map(source.signals.map(signal => [signal.name, signal]));
  const ports = diagram.signals.filter(signal => signal.direction && !signal.name.includes('.'));
  const prefixes = new Set(source.signals.map(signal => signal.name.slice(0, signal.name.lastIndexOf('.') + 1)));
  let prefix = '';
  let matches = 0;
  for (const candidate of prefixes) {
    const score = ports.filter(port => byName.get(candidate + port.name)?.width === port.width).length;
    if (score > matches || (score === matches && score > 0 && candidate && !prefix)) {
      prefix = candidate;
      matches = score;
    }
  }
  if (!matches) return [];
  return diagram.signals.flatMap(signal => {
    const dumped = byName.get(prefix + signal.name);
    return signal.bits && dumped?.width === signal.width ? [{ signal, dumped }] : [];
  });
}
function testbenchPortName(source: WaveTrace, dumped: Signal): string | undefined {
  const candidates = source.signals.filter(signal => signal.id !== dumped.id && signal.width === dumped.width &&
    !signal.name.includes('.'));
  const aliases = candidates.filter(signal => source.aliases[signal.id] === source.aliases[dumped.id]);
  if (aliases.length === 1) return aliases[0].name;
  // Icarus can emit separate VCD identifiers for the two sides of a vector port.
  const name = dumped.name.split('.').at(-1);
  const sameName = candidates.find(signal => signal.name === name);
  if (!sameName) return undefined;
  if (aliases.includes(sameName)) return sameName.name;
  const portWave = source.waves[dumped.id];
  const testbenchWave = source.waves[sameName.id];
  if (portWave.length && portWave.length === testbenchWave.length && portWave.every(({ time, value }, index) =>
    time === testbenchWave[index].time && value.every((bit, lane) => bit === testbenchWave[index].value[lane]))) return sameName.name;
}
function traceDiagramValues(source: WaveTrace): Vector {
  const values: Vector = [];
  for (const { signal, dumped } of traceDiagramSignals) {
    const changes = source.waves[dumped.id];
    const current = changes[changeAt(changes, cursor)]?.value;
    if (!current) continue;
    signal.bits?.forEach((bit, index) => {
      if (typeof bit === 'number') values[bit] = current[index];
    });
  }
  return values;
}
function loadTestbenchDiagram(result?: BuildResult) {
  if (!result?.ok || !result.netlist || !result.top) {
    el('schematic').querySelector('.empty')!.textContent = 'RTL 电路图不可用。请确认已提供被测模块源码，或查看诊断与日志。';
    return;
  }
  design = compile(result.netlist, result.top, result.sourceNetlist);
  if (trace) traceDiagramSignals = linkTraceDiagram(trace, design);
  const root = design.scopes.find(scope => scope.id === design!.root)!;
  const signals = new Map(design.signals.filter(signal => signal.direction).map(signal => [signal.id, signal]));
  const pins = root.parts.flatMap(part => {
    const signal = part.signal ? signals.get(part.signal) : undefined;
    return signal?.bits && signal.direction
      ? [{ name: part.name, bits: signal.bits, direction: signal.direction, signal: signal.id }] : [];
  });
  const dumpedByPort = new Map(traceDiagramSignals.map(({ signal, dumped }) => [signal.id, dumped]));
  const terminals: Part[] = pins.map(pin => {
    const signal = signals.get(pin.signal)!;
    const dumped = dumpedByPort.get(pin.signal);
    const name = (trace && dumped && testbenchPortName(trace, dumped)) || pin.name;
    return {
      id: pin.signal, signal: pin.signal, name,
      type: pin.direction === 'input' && (signal.clock || dumped?.clock) ? 'clock' : pin.direction,
      pins: [{ name, bits: pin.bits, direction: pin.direction === 'input' ? 'output' : pin.direction === 'output' ? 'input' : 'inout' }],
    };
  });
  const id = JSON.stringify([]);
  dutOverview = {
    id, label: 'DUT', signalIds: pins.map(pin => pin.signal),
    parts: [{ id, name: result.top, type: result.top, child: root.id, interfaceOnly: true, pins }, ...terminals],
  };
  scopes = [id];
  void showScope();
}
function traceClock() {
  return trace?.signals.find(signal => signal.clock && signal.width === 1);
}
function nextTracePoint(clockOnly: boolean) {
  if (!trace) return;
  let next = trace.end;
  const clock = traceClock();
  const signals = clockOnly ? (clock ? [clock] : []) : watchedSignals();
  for (const signal of signals) {
    const changes = trace.waves[signal.id];
    const index = changeAt(changes, cursor) + 1;
    if (!clockOnly) next = Math.min(next, changes[index]?.time ?? next);
    else {
      for (let i = Math.max(1, index); i < changes.length; i++) {
        if (changes[i - 1].value[0] === '0' && changes[i].value[0] === '1') {
          next = changes[i].time;
          break;
        }
      }
    }
  }
  seek(next);
}

function loadTestbench(result?: TestbenchResult, simulator: TestbenchSimulator = 'icarus') {
  const label = testbenchSimulatorLabels[result?.simulator ?? simulator];
  if (!result) { status('正在运行 ' + label + '…'); return; }
  el('log').textContent = result.diagram ? `[${label} Testbench]
${result.log}

[RTL Synthesis]
${result.diagram.log}` : result.log;
  if (!result.trace) {
    loadTestbenchDiagram(result.diagram);
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
  loadTestbenchDiagram(result.diagram);
  viewSpan = end = Math.max(1, trace.end);
  cursor = viewStart = 0;
  const rootDepth = Math.min(...trace.signals.map(signal => signal.name.split('.').length));
  watched = new Set(trace.signals.filter(signal => signal.name.split('.').length === rootDepth).slice(0, 16).map(signal => signal.id));
  el('net-status').textContent = label + ' · VCD';
  selectWorkbenchTab(button('view-wave'));
  draw();
  status(`Testbench 运行完成 · ${trace.signals.length} 个信号`);
}
function draw() {
  const signals = watchedSignals();
  const displayFrame = trace ? traceFrame(trace, signals) : frame;
  const displayCursor = displayFrame?.cursor ?? cursor;
  const values = trace ? traceDiagramValues(trace) : frame?.values ?? [];
  schematic.update(values, palette, radixFor, chipType);
  if (testbenchView) waveform.update({ signals, start: viewStart, end: viewEnd(), cursor: displayCursor, stepPs, frame: displayFrame, palette, radixFor });
  el('time-readout').textContent = `${nsAt(displayCursor)} / ${nsAt(end)} ns`;
  el('preview').textContent = trace ? `VCD · ${nsAt(trace.end)} ns` : !design ? '' : simulationError ? '仿真不可用' : (frame?.computed ?? -1) < viewEnd()
    ? `预览计算中 · ${Math.max(0, nsAt(frame?.computed ?? 0))} ns`
    : `已计算至 ${nsAt(Math.min(end, frame!.computed))} ns`;
  button('play').disabled = !trace;
  button('rewind').disabled = !trace;
  button('step').disabled = !trace || playing || cursor >= end;
  button('cycle').disabled = !traceClock() || playing || cursor >= end;
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
function zoomWave(scale: number, anchor: number) {
  const next = Math.max(1, Math.min(end, Math.round(viewSpan * scale)));
  if (next !== viewSpan) setView(anchor - (anchor - viewStart) * next / viewSpan, next);
}
function seek(time: number) {
  cursor = Math.max(0, Math.min(end, time));
  if (trace) draw();
  else request();
}
function stop() {
  playing = false;
  clearInterval(playTimer);
  button('play').classList.remove('playing');
  el('play-label').textContent = '运行';
  button('step').disabled = !trace || cursor >= end;
  button('cycle').disabled = !traceClock() || cursor >= end;
}
function toggleRun() {
  if (playing) { stop(); return; }
  if (!trace) return;
  if (cursor >= end) seek(0);
  playing = true;
  button('play').classList.add('playing');
  el('play-label').textContent = '暂停';
  button('step').disabled = true;
  button('cycle').disabled = true;
  let last = performance.now();
  let accruedPs = 0;
  const rate = Math.max(playbackNsPerSecond, nsAt(end) / 8);
  playTimer = setInterval(() => {
    const now = performance.now();
    accruedPs += (now - last) * rate;
    last = now;
    if (cursor >= end) { stop(); return; }
    const ticks = Math.floor(accruedPs / stepPs);
    if (ticks) {
      accruedPs -= ticks * stepPs;
      seek(cursor + ticks);
    }
  }, 30);
}

function handlePart(part: Part) {
  if (part.child) { scopes.push(part.child); showScope(); }
}
function handleWave(time: number, _signal?: Signal, alternate = false) {
  if (trace && !alternate && !playing) seek(time);
}

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
    if (design || synthesisBusy) void synthesize();
  };
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 'rtl' : event.key === 'End' ? 'gate' : modes.find(level => level !== mode)!;
    button('mode-' + target).click();
  };
}
on('target-platform', 'change', () => {
  const platform = select('target-platform').value as TargetPlatform;
  showTargetPlatform(platform);
  void workbench.targetPlatform(platform).catch(error => status(String(error), true));
});
on('synthesize', 'click', () => { void synthesize(); });
on('run-sta', 'click', () => { void runSta(); });
on('sta-show-log', 'click', () => {
  selectWorkbenchTab(button('view-log'));
  const details = el<HTMLDetailsElement>('sta-log-details');
  details.open = true;
  details.scrollIntoView({ block: 'start' });
});
on('build-bitstream', 'click', () => { void buildBitstream(); });
on('detect-jlink', 'click', () => { void runJtag(false); });
on('program-jlink', 'click', () => { void runJtag(true); });
on('show-signals', 'click', () => { inspector = 'signals'; renderInspector(); });
on('show-parts', 'click', () => { inspector = 'parts'; renderInspector(); });
on('signal-filter', 'input', renderInspector);
on('wave-signal-filter', 'input', renderWaveSignalPicker);
on('rewind', 'click', () => { stop(); seek(0); });
on('step', 'click', () => nextTracePoint(false));
on('cycle', 'click', () => nextTracePoint(true));
on('play', 'click', toggleRun);
on('diagram-fit', 'click', () => schematic.fit());
on('critical-path', 'click', () => {
  const toggle = button('critical-path');
  toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'));
  refreshCriticalPath();
});
on('wave-fit', 'click', () => setView(0, end));
document.addEventListener('keydown', event => {
  if ((event.code !== 'Space' && event.key !== ' ') || event.defaultPrevented || event.isComposing ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      !el('wave-view').getClientRects().length || document.querySelector('dialog[open]')) return;
  const control = event.target instanceof Element
    ? event.target.closest('button, input, select, textarea, [contenteditable]') : null;
  if (control && control.id !== 'view-wave' && control.id !== 'wave-fit') return;
  event.preventDefault();
  setView(0, end);
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
split('inspect-split', '--inspect-width', event => Math.max(174, Math.min(innerWidth - 580, innerWidth - event.clientX - 9)));
bindWorkbenchTabs();
new MutationObserver(() => {
  palette = themedPalette();
  renderPalette();
  renderInspector();
  draw();
}).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
workbench.connect((sources, platform) => {
  if (platform) showTargetPlatform(platform);
  hostSources = sources;
  inputsChanged();
}, loadTestbench);
renderPalette();
renderInspector();
draw();
queueLint();
