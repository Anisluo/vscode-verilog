import { run } from './tool-process';
import { implementFpga, fpgaDatabase } from './fpga';
import type { FpgaOptions } from './fpga';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, delimiter, parse } from 'node:path';
import type { BuildOptions, BuildResult, Diagnostic, Netlist, Source, SynthesisStage } from './protocol';

// Slang expands a command file with its own argument parser. This keeps paths
// containing spaces out of the Yosys command parser.
function quote(value: string) {
  if (/[";\r\n\0\\]/.test(value)) throw new Error('综合选项含不支持的字符。');
  return `"${value}"`;
}

export interface TimingOptions {
  liberty: string;
  sdc: string;
  executable?: string;
  wslDistro?: string;
}
function buildScript(options: BuildOptions, files: string[], includes: string[], lint: boolean, timing: boolean, fpga: boolean) {
  const { standard, top, mode, hierarchy, optimize, abc, observe, defines, parameters } = options;
  if (!['1364-2005', '1800-2017', '1800-2023'].includes(standard)) throw new Error('不支持的语言版本。');
  if (top && !/^[\w$]+$/.test(top)) throw new Error('顶层模块需为常规 HDL 标识符。');
  const read = ['--std', standard];
  if (lint) read.push('--lint-only');
  if (top && !lint) read.push('--top', top);
  if (hierarchy && !lint) read.push('--best-effort-hierarchy');
  for (const directory of includes) read.push('-I', quote(directory.replaceAll('\\', '/')));
  for (const define of defines) read.push('-D', quote(define));
  if (!lint) for (const parameter of parameters) read.push('-G', quote(parameter));
  read.push(...files.map(quote));
  const args = read.join('\n');
  const commands = ['read_slang -F inputs.f'];
  if (lint) return { args, script: commands[0] };
  if (fpga) {
    commands.push('hierarchy -check -auto-top', 'scratchpad -set abc.nocleanup 1',
      'synth_xilinx -family xc7 -flatten', 'write_json design.json');
    return { args, script: commands.join('\n') };
  }
  commands.push('hierarchy -check -auto-top', 'proc', 'write_json source.json');
  if (timing) {
    commands.push('synth -flatten -noabc', 'dfflibmap -liberty timing.lib',
      'scratchpad -set abc.nocleanup 1', 'abc -liberty timing.lib', 'clean', 'read_liberty -lib timing.lib', 'check -assert -mapped',
      'write_verilog -noattr -noexpr -nohex timing.v', 'write_json design.json');
    return { args, script: commands.join('\n') };
  }
  if (observe) commands.push('setattr -set keep 1 w:*');
  if (mode === 'gate') {
    // Relative ABC scratch paths work with spaces and '#' in user profiles.
    // The parent job directory owns cleanup of all scratch files.
    if (abc) commands.push('scratchpad -set abc.nocleanup 1');
    // Preserve source-encoded state registers when source observation is enabled.
    commands.push(`synth${abc ? '' : ' -noabc'}${observe ? ' -nofsm' : ''}`);
  }
  else {
    commands.push('memory_map');
    if (optimize) commands.push('opt -keepdc');
  }
  commands.push(...(options.extraCommands ?? []), 'write_json design.json');
  return { args, script: commands.join('\n') };
}

function overlayPath(path: string) {
  const root = parse(path).root;
  const drive = root.replace(/[^a-z0-9]/gi, '_');
  return join('src', drive, path.slice(root.length));
}

function diagnostics(log: string, files: Map<string, Source>) {
  const result: Diagnostic[] = [];
  const lines = log.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = /^(.+?):(\d+):(?:(\d+):)?\s+(error|warning|note):\s+(.+)$/i.exec(line.trim());
    if (!match) continue;
    const file = match[1].replaceAll('\\', '/');
    const source = files.get(file) ?? [...files].find(([name]) => file.endsWith('/' + name))?.[1];
    if (source) result.push({
      id: source.id, line: Number(match[2]), column: Number(match[3]) || Math.max(1, (lines[index + 2]?.indexOf('^') ?? -1) + 1),
      severity: match[4].toLowerCase() as Diagnostic['severity'], message: match[5],
    });
  }
  return result;
}

async function analyzeTiming(workspace: string, top: string, timing: TimingOptions) {
  if (!/^[A-Za-z_][\w$]*$/.test(top)) throw new Error('STA 需要常规 HDL 顶层模块名。');
  const script = `if {[catch {
  read_liberty timing.lib
  read_verilog timing.v
  link_design {${top}}
  read_sdc timing.sdc
  if {[llength [get_clocks *]] == 0} { error {No clock was defined by the SDC.} }
  puts "\n=== Constraint coverage ==="
  if {[llength [info commands report_units]]} { report_units }
  check_setup -verbose
  puts "\n=== Setup (max delay), worst paths first ==="
  report_checks -path_delay max -sort_by_slack -digits 3
  puts "\n=== Hold (min delay), worst paths first ==="
  report_checks -path_delay min -sort_by_slack -digits 3
} message]} {
  puts stderr "STA ERROR: $message"
  exit 1
}
`;
  await writeFile(join(workspace, 'timing.tcl'), script, 'utf8');
  const staArgs = ['-no_init', '-exit', 'timing.tcl'];
  const useWsl = process.platform === 'win32' && !timing.executable;
  const executable = useWsl ? 'wsl.exe' : timing.executable || 'sta';
  const args = useWsl
    ? [...(timing.wslDistro ? ['-d', timing.wslDistro] : []), '--cd', workspace, '--exec', 'sta', ...staArgs]
    : staArgs;
  const { code, log } = await run(executable, args, workspace, { ...process.env, WSL_UTF8: '1' });
  return code === 0 ? log : `${log}\nSTA ERROR: OpenSTA exited with status ${code}.`;
}

export async function hdlJob(sources: Source[], options: BuildOptions, lint: boolean, configuredRoot?: string, progress?: (stage: SynthesisStage) => void, timing?: TimingOptions, fpga?: FpgaOptions): Promise<BuildResult> {
  let workspace: string | undefined;
  try {
    workspace = await mkdtemp(join(tmpdir(), 'vscode-verilog-'));
    const executableName = process.platform === 'win32' ? 'yosys.exe' : 'yosys';
    const root = fpga?.yosysRoot || configuredRoot || process.env.VERILOG_IDE_TOOLCHAIN;
    const executableFile = lint ? (process.platform === 'win32' ? 'slang.exe' : 'slang') : executableName;
    const executable = root ? join(resolve(root), 'bin', executableFile) : executableFile;
    const environment = { ...process.env };
    if (root) {
      for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PATH') delete environment[key];
      environment.PATH = [join(root, 'bin'), ...(process.platform === 'win32' ? [join(root, 'lib')] : []), process.env.PATH].join(delimiter);
    }
    const files = new Map<string, Source>();
    const includes = new Set(options.includes);
    const inputs: string[] = [];
    for (const [index, source] of sources.entries()) {
      const relative = (source.path ? overlayPath(source.path) : join('scratch', basename(source.name)))
        .replaceAll('\\', '/');
      if (files.has(relative)) throw new Error(`文件名重复：${source.name}`);
      const path = join(workspace, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source.text, 'utf8');
      files.set(relative, source);
      if (source.path) {
        files.set(source.path.replaceAll('\\', '/'), source);
        includes.add(dirname(source.path));
      } else if (!source.name) throw new Error(`文件 ${index + 1} 缺少名称。`);
      if (!/\.(svh|vh)$/i.test(source.name)) inputs.push(relative);
    }
    if (!inputs.length) return { ok: false, log: '请打开或新建 HDL 源文件。', diagnostics: [] };
    if (timing) {
      await writeFile(join(workspace, 'timing.lib'), await readFile(timing.liberty));
      await writeFile(join(workspace, 'timing.sdc'), await readFile(timing.sdc));
    }
    const fpgaDevice = fpga && await fpgaDatabase(fpga.openXc7Root, fpga.part);
    if (fpga) await writeFile(join(workspace, 'board.xdc'), await readFile(fpga.constraints));
    const { args, script } = buildScript(options, inputs, [...includes], lint, !!timing, !!fpga);
    await writeFile(join(workspace, 'job.ys'), script, 'utf8');
    await writeFile(join(workspace, 'inputs.f'), args, 'utf8');
    progress?.('synthesis');
    // Keep the interactive schematic log focused on diagnostics. Verbose Yosys
    // optimization progress can exceed the tool output cap on a large SoC.
    const yosysArgs = [...(timing || fpga ? [] : ['-q']), '-Q', '-T', '-s', 'job.ys'];
    const { code, log } = await run(executable, lint ? ['-F', 'inputs.f'] : yosysArgs,
      workspace, environment, fpga ? 600_000 : undefined);
    const result: BuildResult = { ok: code === 0, log: log || (code === 0 ? '' : `HDL 工具退出状态：${code}`), diagnostics: diagnostics(log, files) };
    if (!lint) result.log = `[job.ys]\n${script}\n\n[inputs.f]\n${args}\n\n${result.log}`;
    if (!result.ok || lint) return result;
    progress?.('netlist');
    result.netlist = JSON.parse(await readFile(join(workspace, 'design.json'), 'utf8')) as Netlist;
    if (!fpga) result.sourceNetlist = JSON.parse(await readFile(join(workspace, 'source.json'), 'utf8')) as Netlist;
    result.top = Object.keys(result.netlist.modules).find(name => /1$/.test(result.netlist!.modules[name].attributes?.top ?? ''));
    if (!result.top) throw new Error('网表没有顶层模块。请指定顶层模块。');
    if (fpga && fpgaDevice) {
      try {
        const implementation = await implementFpga(workspace, fpga, fpgaDevice,
          log => { result.log += log; }, progress);
        result.bitstream = implementation.bitstream;
        result.fpgaTiming = implementation.clocks;
        result.fpgaCriticalPaths = implementation.paths;
      } catch (error) {
        result.ok = false;
        result.log += '\n' + String(error);
      }
    }
    if (timing) {
      progress?.('sta');
      try {
        result.timingReport = await analyzeTiming(workspace, result.top, timing);
        result.ok = !/^Error:|^STA ERROR:/m.test(result.timingReport);
      } catch (error) {
        result.ok = false;
        result.timingReport = String(error);
      }
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, log: message.includes('ENOENT') ? '找不到 HDL 工具。开发运行需要带 read_slang 的 Yosys 和独立 slang，可通过 VERILOG_IDE_TOOLCHAIN 指定目录。\n' + message : message, diagnostics: [] };
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
