import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './backend';
import { parseVcd } from './vcd';
import type { Source } from './protocol';
import type { WaveTrace } from './vcd';

export interface TestbenchResult {
  log: string;
  trace?: WaveTrace;
}

export async function runTestbench(sources: Source[], top: string, bin?: string): Promise<TestbenchResult> {
  let dir: string | undefined;
  let log = '';
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
    const compileArgs = ['-g2012', '-s', top, '-o', 'simulation.vvp',
      ...[...includeDirs].flatMap(path => ['-I', path]), ...inputs];
    log += 'iverilog ' + compileArgs.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ') + '\n';
    const compiled = await run(tool('iverilog'), compileArgs, dir, env);
    log += compiled.log;
    if (compiled.code !== 0) throw new Error('Icarus Verilog 编译失败。');

    log += '\nvvp -N simulation.vvp\n';
    const simulated = await run(tool('vvp'), ['-N', 'simulation.vvp'], dir, env);
    log += simulated.log;
    if (simulated.code !== 0) throw new Error('Testbench 仿真失败（退出码 ' + simulated.code + '）。');
    const dumps = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && /\.vcd$/i.test(entry.name));
    if (dumps.length !== 1) throw new Error('请用 $dumpfile 和 $dumpvars 在仿真目录生成一个 VCD 文件。');
    const file = join(dir, dumps[0].name);
    if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('VCD 超过 16 MB，无法在工作台显示。');
    return { log, trace: parseVcd(await readFile(file, 'utf8')) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = message.includes('ENOENT')
      ? '找不到 Icarus Verilog。请把 iverilog 和 vvp 加到 PATH，或设置 verilogWorkbench.icarusPath。'
      : message;
    return { log: log + '\n' + detail };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
