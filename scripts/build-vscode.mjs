import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = 'vscode/dist';
const common = { absWorkingDir: root, bundle: true, outdir };
const browser = { ...common, platform: 'browser', target: 'chrome128' };

await Promise.all(['../vscode/dist/', '../release/'].map(path =>
  mkdir(new URL(path, import.meta.url), { recursive: true })));
await Promise.all([
  build({ ...common, entryPoints: ['vscode/src/extension.ts'], platform: 'node', target: 'node20',
    format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['vscode'] }),
  build({ ...browser, entryPoints: { renderer: 'src/renderer.ts' }, format: 'esm' }),
  build({ ...browser, entryPoints: { 'sim-worker': 'src/sim-worker.ts', 'layout-worker': 'src/layout-worker.ts' }, format: 'iife' }),
  cp(new URL('../node_modules/elkjs/lib/elk-worker.min.js', import.meta.url), new URL('../vscode/dist/elk-worker.js', import.meta.url)),
  ...['src/index.html', 'LICENSE'].map(path => cp(new URL('../' + path, import.meta.url),
    new URL('../vscode/' + (path.startsWith('src/') ? 'dist/' + path.slice(4) : path), import.meta.url))),
]);
