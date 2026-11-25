import { access, readFile, readdir } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { run } from './tool-process';
import type { FpgaClockTiming, SynthesisStage } from './protocol';

export interface FpgaOptions {
  part: string;
  constraints: string;
  openXc7Root: string;
  yosysRoot: string;
  timingOnly?: boolean;
}

export async function discoverFpgaConstraints(source: string, workspace: string, top: string) {
  const sourceDir = dirname(source);
  const directories = [...new Set([sourceDir, workspace, join(sourceDir, 'constraints'), join(workspace, 'constraints')])];
  const paths = (await Promise.all(directories.map(async directory => {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.filter(entry => entry.isFile() && /\.xdc$/i.test(entry.name)).map(entry => resolve(directory, entry.name));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
      throw error;
    }
  }))).flat();
  if (paths.length === 1) return paths[0];
  if (!paths.length) throw new Error('未找到 XDC。请放到顶层源码目录、工作区根目录或 constraints/ 子目录，也可以设置 verilogWorkbench.fpgaXdc。');
  for (const stem of [top, basename(source, extname(source))].filter(Boolean)) {
    const matching = paths.filter(path => basename(path).toLowerCase() === stem.toLowerCase() + '.xdc');
    if (matching.length === 1) return matching[0];
    if (matching.length > 1) break;
  }
  throw new Error('找到多个 XDC，请设置 verilogWorkbench.fpgaXdc：\n' + paths.join('\n'));
}

const windows = process.platform === 'win32';
export async function fpgaDatabase(root: string, part: string) {
  if (!/^xc7[askz][a-z0-9]+-[a-z0-9]+$/.test(part)) {
    throw new Error('请使用完整 XC7 器件型号，包含封装和速度等级，例如 xc7z010clg400-1。');
  }
  const family = { a: 'artix7', s: 'spartan7', k: 'kintex7', z: 'zynq7' }[part[3]]!;
  const database = join(root, 'share', 'nextpnr', 'external', 'prjxray-db', family);
  const device = join(database, part, 'part.yaml');
  const inventory = join(root, 'share', 'nextpnr', 'himbaechel', 'xilinx', 'XILINX-PARTS-INVENTORY.json');
  const parts = JSON.parse(await readFile(inventory, 'utf8')) as {
    parts: Record<string, { generated: boolean }>;
  };
  if (!parts.parts[part]?.generated) throw new Error('当前 openXC7 工具包未构建设备数据库：' + part);
  await access(device);
  return { database, device };
}

export async function implementFpga(
  workspace: string, fpga: FpgaOptions, { database, device }: Awaited<ReturnType<typeof fpgaDatabase>>,
  report: (log: string) => void, progress?: (stage: SynthesisStage) => void,
) {
  const { part, openXc7Root, yosysRoot } = fpga;
  const bin = (name: string) => join(openXc7Root, 'bin', name + (windows ? '.exe' : ''));
  const environment = { ...process.env };
  if (windows) {
    const prior = Object.keys(environment).find(key => key.toUpperCase() === 'PYTHONPATH');
    if (prior) delete environment[prior];
    environment.PYTHONPATH = [
      join(openXc7Root, 'lib', 'python3.12', 'site-packages'), process.env.PYTHONPATH,
    ].filter(Boolean).join(delimiter);
  }
  const execute = async (label: string, executable: string, args: string[]) => {
    report('\n[' + label + ']\n');
    const result = await run(executable, args, workspace, environment, 600_000);
    report(result.log);
    if (result.code !== 0) throw new Error(label + ' 失败，退出码 ' + result.code + '。');
  };
  progress?.('place-route');
  await execute('nextpnr-xilinx', bin('nextpnr-xilinx'), [
    '--device', part, '-o', 'xdc=board.xdc',
    '--json', 'design.json', '--report', 'nextpnr.json',
    ...(fpga.timingOnly ? ['--timing-allow-fail'] : ['-o', 'fasm=design.fasm']),
  ]);
  const { fmax: clocks } = JSON.parse(await readFile(join(workspace, 'nextpnr.json'), 'utf8')) as { fmax?: FpgaClockTiming };
  if (fpga.timingOnly) return { clocks };
  progress?.('bitstream');
  await execute('FASM → Frames', windows ? join(yosysRoot, 'lib', 'python3.exe') : bin('fasm2frames'), [
    ...(windows ? [join(openXc7Root, 'libexec', 'fasm2frames')] : []),
    '--part', part, '--db-root', database, 'design.fasm', 'design.frames',
  ]);
  await execute('Frames → Bitstream', bin('xc7frames2bit'), [
    '--part_file', device, '--part_name', part, '--frm_file', 'design.frames', '--output_file', 'design.bit',
  ]);
  const bitstream = await readFile(join(workspace, 'design.bit'));
  if (!bitstream.length) throw new Error('openXC7 生成了空的 .bit 文件。');
  return { clocks, bitstream };
}
