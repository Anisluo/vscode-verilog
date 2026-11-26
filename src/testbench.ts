import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './tool-process';
import { parseVcd } from './vcd';
import { testbenchSimulatorLabels } from './protocol';
import type { BuildResult, Source, TestbenchSimulator } from './protocol';
import type { WaveTrace } from './vcd';

interface VerilatorOptions { executable?: string; wslDistro?: string }
type TestbenchOptions = { simulator?: 'icarus'; bin?: string } | ({ simulator: 'verilator' } & VerilatorOptions);

export interface TestbenchResult {
  simulator?: TestbenchSimulator;
  log: string;
  trace?: WaveTrace;
  diagram?: BuildResult;
}

export async function runTestbench(sources: Source[], top: string, options: TestbenchOptions = {}): Promise<TestbenchResult> {
  let dir: string | undefined;
  let log = '';
  const simulator = options.simulator ?? 'icarus';
  const label = testbenchSimulatorLabels[simulator];
  const bin = options.simulator === 'verilator' ? undefined : options.bin;
  try {
    if (!/^[a-zA-Z_][\w$]*$/.test(top)) throw new Error('Testbench 顶层模块名无效。');
    dir = await mkdtemp(join(tmpdir(), 'vscode-verilog-tb-'));
    const env = { ...process.env };
    if (bin) {
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
      env.PATH = [bin, process.env.PATH].join(delimiter);
    }
    const tool = (name: string) => bin ? join(bin, process.platform === 'win32' ? name + '.exe' : name) : name;
    const names = new Set<string>();
    const inputs: string[] = [];
    const includeDirs = new Set<string>(['.']);
    for (const source of sources) {
      const name = basename(source.name);
      const key = process.platform === 'win32' ? name.toLowerCase() : name;
      if (names.has(key)) throw new Error('Testbench 源文件重名：' + name);
      names.add(key);
      await writeFile(join(dir, name), source.text, 'utf8');
      if (/\.(v|sv)$/i.test(name)) inputs.push('./' + name);
      if (source.path) includeDirs.add(dirname(source.path));
    }
    const execute = async (executable: string, args: string[], timeout?: number) => {
      log += [executable, ...args].map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ') + '\n';
      const result = await run(executable, args, dir!, env, timeout);
      log += result.log + '\n';
      return result.code;
    };
    let exitCode: number | null;
    if (options.simulator === 'verilator') {
      const wsl = process.platform === 'win32' && !options.executable;
      const prefix = options.wslDistro ? ['-d', options.wslDistro] : [];
      const filename = process.platform === 'win32' && !wsl ? 'simulation.exe' : 'simulation';
      if (wsl) env.WSL_UTF8 = '1';
      const invoke = (tool: string, args: string[], timeout?: number) => wsl
        ? execute('wsl.exe', [...prefix, '--cd', dir!, '--exec', tool, ...args], timeout)
        : execute(tool, args, timeout);
      const includes = await Promise.all([...includeDirs].map(async path => {
        if (!wsl || path === '.') return path;
        const converted = await run('wsl.exe', [...prefix, '--exec', 'wslpath', '-a', path], dir!, env);
        const mapped = converted.log.split(/\r?\n/).filter(line => line.startsWith('/')).at(-1);
        if (converted.code !== 0 || !mapped) throw new Error('无法将包含目录转换为 WSL 路径：' + path);
        return mapped;
      }));
      const compiled = await invoke(options.executable || 'verilator', [
        '--binary', '--timing', '--trace', '--assert', '-Wno-fatal', '-j', '2',
        '--top-module', top, '--main-top-name', '-', '--Mdir', 'obj_dir', '-o', filename,
        ...includes.map(path => '-I' + path), ...inputs,
      ], 300_000);
      if (compiled !== 0) throw new Error('Verilator 编译失败。请检查 Verilator、C++ 编译器和 make。');
      exitCode = await invoke(wsl ? './obj_dir/' + filename : join(dir, 'obj_dir', filename), []);
    } else {
      const compiled = await execute(tool('iverilog'), [
        '-g2012', '-s', top, '-o', 'simulation.vvp', ...[...includeDirs].flatMap(path => ['-I', path]), ...inputs,
      ]);
      if (compiled !== 0) throw new Error('Icarus Verilog 编译失败。');
      exitCode = await execute(tool('vvp'), ['-N', 'simulation.vvp']);
    }
    if (exitCode !== 0) throw new Error(label + ' 仿真失败（退出码 ' + exitCode + '）。');
    const dumps = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && /\.vcd$/i.test(entry.name));
    if (dumps.length !== 1) throw new Error('请用 $dumpfile 和 $dumpvars 在仿真目录生成一个 VCD 文件。');
    const file = join(dir, dumps[0].name);
    if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('VCD 超过 16 MB，无法在工作台显示。');
    return { simulator, log, trace: parseVcd(await readFile(file, 'utf8')) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = message.includes('ENOENT')
      ? (simulator === 'icarus'
        ? '找不到 Icarus Verilog。请把 iverilog 和 vvp 加到 PATH，或设置 verilogWorkbench.icarusPath。'
        : '找不到 Verilator、WSL 或仿真程序。请检查 Verilator 的安装与插件设置。')
      : message;
    return { simulator, log: log + '\n' + detail };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
