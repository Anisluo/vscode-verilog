import { access } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { run } from './tool-process';

export interface JtagBitstream { path: string; part: string }

export async function runJlink(toolchain: string | undefined, cable: string, folder: string, bitstream?: JtagBitstream) {
  if (cable !== 'jlink' && cable !== 'jlink_base') throw new Error('请选择 jlink 或 jlink_base。');
  const windows = process.platform === 'win32';
  const program = 'openFPGALoader' + (windows ? '.exe' : '');
  const executable = toolchain ? join(toolchain, 'bin', program) : program;
  const environment = { ...process.env };
  if (toolchain) {
    for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PATH') delete environment[key];
    environment.PATH = [join(toolchain, 'bin'), join(toolchain, 'lib'), process.env.PATH].join(delimiter);
  }
  const args = ['--cable', cable, '--freq', '1000000'];
  try {
    if (bitstream) await access(bitstream.path);
    const detect = await run(executable, [...args, '--detect'], folder, environment);
    const log = '[openFPGALoader --detect · ' + cable + ']\n' + detect.log;
    if (detect.code !== 0) {
      const hint = windows && /can.t find compatible device|libusb/i.test(detect.log)
        ? '\n确认 J-Link 型号、USB 驱动是否允许 libusb 访问，以及 FPGA 板是否供电。' : '';
      return { ok: false, log: log + hint };
    }
    const chain = detect.log.replace(/\x1b\[[0-9;]*m/g, '').split(/^index \d+:/m).slice(1);
    if (!chain.length) return { ok: false, log: log + '\nJTAG 链未返回器件。' };
    if (!bitstream) return { ok: true, log };
    const model = bitstream.part.match(/^xc7[askz]\d+t?/i)?.[0].toLowerCase();
    const matches = chain.flatMap((entry, index) => {
      const device = entry.match(/^\s*model\s+(\S+)/m)?.[1].toLowerCase();
      return model && device === model ? [index] : [];
    });
    if (matches.length !== 1) {
      return { ok: false, log: log + '\nJTAG 链中需要且只能有一个匹配的 FPGA（' + bitstream.part + '）。' };
    }
    const written = await run(executable, [
      ...args, '--index-chain', String(matches[0]), '--write-sram', bitstream.path,
    ], dirname(bitstream.path), environment, 120_000);
    return { ok: written.code === 0, log: log + '\n[openFPGALoader --write-sram]\n' + written.log };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, log: '找不到 openFPGALoader 或已生成的 .bit 文件。请检查 OSS CAD Suite 路径，必要时重新编译。' };
    }
    throw error;
  }
}
