import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = 'win32-x64';
const { values } = parseArgs({ options: {
  'hdl-root': { type: 'string', default: process.env.VERILOG_IDE_TOOLCHAIN },
  'icarus-root': { type: 'string', default: process.env.VSCODE_VERILOG_ICARUS_ROOT },
} });

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Bundled VSIX packaging currently supports Windows x64.');
}
if (!values['hdl-root'] || !values['icarus-root']) {
  throw new Error('Provide --hdl-root <Yosys/slang toolchain root> and --icarus-root <Icarus distribution root>.');
}
const hdl = resolve(values['hdl-root']);
const icarus = resolve(values['icarus-root']);
const requirements = [
  join(hdl, 'bin', 'yosys.exe'), join(hdl, 'bin', 'slang.exe'), join(hdl, 'bin', 'yosys-abc.exe'),
  join(hdl, 'share', 'yosys'), join(hdl, 'license'),
  join(icarus, 'bin', 'iverilog.exe'), join(icarus, 'bin', 'vvp.exe'), join(icarus, 'lib', 'ivl'),
  join(icarus, 'share', 'licenses'),
];
for (const file of requirements) {
  if (!await stat(file).catch(() => undefined)) throw new Error('Missing toolchain file or directory: ' + file);
}

const staging = await mkdtemp(join(tmpdir(), 'vscode-verilog-vsix-'));
try {
  await Promise.all(['dist', 'examples', 'README.md', 'LICENSE', 'package.json', '.vscodeignore'].map(file =>
    cp(join(root, 'vscode', file), join(staging, file), { recursive: true })));
  const toolchain = join(staging, 'tools', target);
  await mkdir(toolchain, { recursive: true });
  const yosys = join(toolchain, 'hdl');
  const icarusDir = join(toolchain, 'icarus');
  await Promise.all([
    ...['bin', 'lib', 'share', 'license'].map(file => cp(join(hdl, file), join(yosys, file), { recursive: true })),
    cp(join(icarus, 'lib', 'ivl'), join(icarusDir, 'lib', 'ivl'), { recursive: true }),
    cp(join(icarus, 'share', 'licenses'), join(icarusDir, 'share', 'licenses'), { recursive: true }),
    cp(join(root, 'vscode', 'THIRD-PARTY-NOTICES.md'), join(staging, 'THIRD-PARTY-NOTICES.md')),
  ]);
  const bin = join(icarusDir, 'bin');
  await mkdir(bin, { recursive: true });
  const binaries = (await readdir(join(icarus, 'bin'))).filter(file => /^(iverilog|vvp)\.exe$|\.dll$/i.test(file));
  await Promise.all(binaries.map(file => cp(join(icarus, 'bin', file), join(bin, file))));

  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'exec', '--yes', '--package', '@vscode/vsce@3.9.1',
    '--', 'vsce', 'package', '--target', target, '--out', join(root, 'release')], { cwd: staging, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('VSIX packaging failed with exit code ' + result.status + '.');
} finally {
  await rm(staging, { recursive: true, force: true });
}
