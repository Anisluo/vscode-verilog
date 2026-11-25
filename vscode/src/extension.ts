import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { hdlJob } from '../../src/backend';
import { runJlink } from '../../src/jtag';
import type { JtagBitstream } from '../../src/jtag';
import type { FpgaOptions } from '../../src/fpga';
import type { TimingOptions } from '../../src/backend';
import { runTestbench } from '../../src/testbench';
import type { TestbenchResult } from '../../src/testbench';
import type { BuildOptions, Diagnostic, Source, TargetPlatform } from '../../src/protocol';

const inputFile = /\.(v|sv)$/i;
const hdlFile = /\.(v|sv|vh|svh)$/i;
const command = 'verilogWorkbench.open';

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection('slang');
  let panel: vscode.WebviewPanel | undefined;
  let primary: vscode.TextDocument | undefined;
  let sources: Source[] = [];
  let ready = false;
  let refreshVersion = 0;
  let diagnosticVersion = 0;
  const assets = vscode.Uri.joinPath(context.extensionUri, 'dist');
  const example = vscode.Uri.joinPath(context.extensionUri, 'examples', 'fifo_4x8.v');

  const configuration = () => vscode.workspace.getConfiguration('verilogWorkbench', primary?.uri);
  const bundledTools = vscode.Uri.joinPath(context.extensionUri, 'tools', `${process.platform}-${process.arch}`).fsPath;

  async function bundled(root: string, files: string[]) {
    const directory = join(bundledTools, root);
    try {
      await Promise.all(files.map(file => access(join(directory, file))));
      return directory;
    } catch {
      return undefined;
    }
  }

  async function refresh() {
    const target = panel;
    const document = primary;
    if (!target || !document || !ready) return;
    const version = ++refreshVersion;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? dirname(document.fileName);
    try {
      const additional = document.uri.toString() === example.toString() ? [] : configuration().get<string[]>('additionalSources', []);
      const paths = additional
        .map(path => vscode.Uri.file(resolve(folder, path)))
        .filter(uri => hdlFile.test(uri.fsPath));
      const entries = new Map([[document.uri.toString(), document.uri], ...paths.map(uri => [uri.toString(), uri] as const)]);
      const snapshot = await Promise.all([...entries].map(async ([id, uri]) => {
        const open = vscode.workspace.textDocuments.find(item => item.uri.toString() === id);
        const text = open?.getText() ?? new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
        return { id, name: basename(uri.fsPath), path: uri.scheme === 'file' ? uri.fsPath : undefined, text };
      }));
      if (target !== panel || version !== refreshVersion) return;
      if (JSON.stringify(snapshot) !== JSON.stringify(sources)) {
        ++diagnosticVersion;
        sources = snapshot;
        diagnostics.clear();
      }
      await target.webview.postMessage({ type: 'sources', sources: sources.map(({ id, name }) => ({ id, name })), platform: configuration().get<TargetPlatform>('targetPlatform', 'asic') });
    } catch (error) {
      if (target !== panel || version !== refreshVersion) return;
      sources = [];
      ++diagnosticVersion;
      diagnostics.clear();
      void target.webview.postMessage({ type: 'sources', sources });
      void vscode.window.showErrorMessage('读取 HDL 源文件失败：' + String(error));
    }
  }

  function publish(items: Diagnostic[], snapshot: Source[]) {
    diagnostics.clear();
    for (const source of snapshot) {
      const entries = items.filter(item => item.id === source.id).map(item => {
        const severity = item.severity === 'error' ? vscode.DiagnosticSeverity.Error
          : item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
        const line = Math.max(0, item.line - 1);
        const column = Math.max(0, item.column - 1);
        const diagnostic = new vscode.Diagnostic(new vscode.Range(line, column, line, column + 1), item.message, severity);
        diagnostic.source = 'slang';
        return diagnostic;
      });
      if (entries.length) diagnostics.set(vscode.Uri.parse(source.id), entries);
    }
  }

  const testbenchName = /(?:_tb\.(v|sv)$|^tb_.*\.(v|sv)$)/i;
  context.subscriptions.push(vscode.commands.registerCommand('verilogWorkbench.runTestbench', async () => {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('请在受信任的工作区运行 Testbench。');
      return;
    }
    const active = vscode.window.activeTextEditor?.document;
    if (!active || !inputFile.test(active.fileName)) {
      void vscode.window.showInformationMessage('请先打开 testbench 或对应的 .v / .sv 模块。');
      return;
    }
    const file = basename(active.fileName);
    const sibling = (name: string) => vscode.Uri.joinPath(active.uri, '..', name);
    function isBundled(uri: vscode.Uri) {
      return dirname(uri.fsPath) === dirname(example.fsPath) && /^fifo_4x8(?:_tb)?\.v$/i.test(basename(uri.fsPath));
    }
    let bench = active.uri;
    let dut = active.uri;
    if (testbenchName.test(file)) {
      const stem = file.replace(/^tb_/i, '').replace(/_tb(?=\.)/i, '').replace(/\.[^.]+$/, '');
      const candidates = [sibling(stem + '.v'), sibling(stem + '.sv')];
      const matches = await Promise.all(candidates.map(async uri => {
        try { await vscode.workspace.fs.stat(uri); return uri; } catch { return undefined; }
      }));
      dut = matches.find(uri => uri !== undefined) ?? active.uri;
    } else {
      const name = file.replace(/\.[^.]+$/, '');
      const candidates = [sibling(name + '_tb.v'), sibling(name + '_tb.sv'), sibling('tb_' + name + '.v'), sibling('tb_' + name + '.sv')];
      const matches = await Promise.all(candidates.map(async uri => {
        try { await vscode.workspace.fs.stat(uri); return uri; } catch { return undefined; }
      }));
      const found = matches.find(uri => uri !== undefined);
      if (!found) {
        void vscode.window.showInformationMessage('未找到配套 Testbench，请打开 _tb.v / _tb.sv 文件再运行。');
        return;
      }
      bench = found;
    }
    const config = vscode.workspace.getConfiguration('verilogWorkbench', bench);
    const folder = vscode.workspace.getWorkspaceFolder(bench)?.uri.fsPath ?? dirname(bench.fsPath);
    const additional = isBundled(bench) ? [] : config.get<string[]>('additionalSources', []);
    const uris = [...new Map([bench, dut, ...additional.map(path => vscode.Uri.file(resolve(folder, path)))]
      .map(uri => [uri.toString(), uri])).values()];
    const top = config.get<string>('testbenchTop', '').trim() || basename(bench.fsPath).replace(/\.[^.]+$/, '');
    const root = config.get<string>('icarusPath', '').trim();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(bench), { viewColumn: vscode.ViewColumn.One });
    const target = vscode.window.createWebviewPanel('verilogTestbench', 'Testbench · ' + top,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [assets], retainContextWhenHidden: true });
    let loaded = false;
    let disposed = false;
    let result: TestbenchResult | undefined;
    const send = () => {
      if (loaded && !disposed) void target.webview.postMessage({ type: 'testbench', result });
    };
    const receiver = target.webview.onDidReceiveMessage(message => {
      if (message.type === 'ready') { loaded = true; send(); }
    });
    target.onDidDispose(() => { disposed = true; receiver.dispose(); });
    try {
      const template = await readFile(vscode.Uri.joinPath(assets, 'index.html').fsPath, 'utf-8');
      target.webview.html = webviewHtml(target.webview, assets, template, true);
      const snapshot = await Promise.all(uris.filter(uri => hdlFile.test(uri.fsPath)).map(async uri => {
        const document = await vscode.workspace.openTextDocument(uri);
        return { id: uri.toString(), name: basename(uri.fsPath), path: uri.fsPath, text: document.getText() };
      }));
      const bin = root ? resolve(folder, root) : await bundled(join('icarus', 'bin'), ['iverilog.exe', 'vvp.exe']);
      const hdlRoot = config.get<string>('toolchainPath', '').trim();
      const hdl = hdlRoot ? resolve(folder, hdlRoot)
        : await bundled('hdl', [join('bin', 'yosys.exe'), join('bin', 'slang.exe')]);
      const designSources = snapshot.filter(source => source.id !== bench.toString());
      const [simulation, diagram] = await Promise.all([
        runTestbench(snapshot, top, bin),
        designSources.some(source => inputFile.test(source.name))
          ? hdlJob(designSources, {
            standard: '1800-2023', top: '', mode: 'rtl', hierarchy: true, optimize: true,
            observe: true, abc: false, includes: [], defines: [], parameters: [],
          }, false, hdl) : undefined,
      ]);
      result = { ...simulation, diagram };
    } catch (error) {
      result = { log: String(error) };
    }
    send();
  }));

  context.subscriptions.push(diagnostics, vscode.commands.registerCommand('verilogWorkbench.example', async () => {
    const document = await vscode.workspace.openTextDocument(example);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand(command, example);
  }), vscode.commands.registerCommand(command, async (uri?: vscode.Uri) => {
    const document = uri instanceof vscode.Uri ? await vscode.workspace.openTextDocument(uri)
      : vscode.window.activeTextEditor?.document ?? primary;
    if (!document || !inputFile.test(document.fileName)) {
      void vscode.window.showInformationMessage('请先打开一个 .v 或 .sv 文件。');
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('请在受信任的工作区运行 HDL 工具。');
      return;
    }
    if (primary?.uri.toString() !== document.uri.toString()) {
      sources = [];
      ++diagnosticVersion;
      diagnostics.clear();
    }
    primary = document;
    if (panel) {
      panel.title = 'Verilog · ' + basename(document.fileName);
      panel.reveal(vscode.ViewColumn.Beside, true);
      await refresh();
      return;
    }
    const target = vscode.window.createWebviewPanel('verilogWorkbench', 'Verilog · ' + basename(document.fileName),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [assets], retainContextWhenHidden: true });
    panel = target;
    ready = false;
    let programmedSource: vscode.TextDocument | undefined;
    let builtBitstream: JtagBitstream | undefined;
    const receiver = target.webview.onDidReceiveMessage(async message => {
      if (target !== panel) return;
      if (message.type === 'ready') {
        ready = true;
        await refresh();
        return;
      }
      if (message.type === 'reveal') {
        const source = sources.find(item => item.id === message.item.id);
        if (!source) return;
        const text = await vscode.workspace.openTextDocument(vscode.Uri.parse(source.id));
        const position = text.validatePosition(new vscode.Position(Math.max(0, message.item.line - 1), Math.max(0, message.item.column - 1)));
        await vscode.window.showTextDocument(text, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(position, position) });
        return;
      }
      const reply = (result: unknown, error?: string) => target === panel
        ? target.webview.postMessage({ type: 'reply', id: message.id, result, error }) : undefined;
      try {
        if (message.type === 'target-platform') {
          const platform = message.payload as TargetPlatform;
          if (platform !== 'asic' && platform !== 'fpga') throw new Error('未知目标平台。');
          const folder = primary && vscode.workspace.getWorkspaceFolder(primary.uri);
          await configuration().update('targetPlatform', platform,
            folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global);
          await reply(undefined);
        }
        if (message.type === 'directory') {
          const choice = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true });
          await reply(choice?.[0]?.fsPath);
        }
        if (message.type === 'jtag-detect' || message.type === 'jtag-program') {
          if (!vscode.workspace.isTrusted) throw new Error('请在受信任的工作区运行 JTAG 工具。');
          const config = configuration();
          const root = config.get<string>('fpgaYosysPath', '').trim();
          const cable = config.get<string>('fpgaJtagCable', 'jlink');
          const program = message.type === 'jtag-program';
          if (program && (!builtBitstream || programmedSource !== primary)) throw new Error('请先为当前设计生成 .bit 文件。');
          const directory = primary?.uri.scheme === 'file' ? dirname(primary.fileName) : context.extensionPath;
          await reply(await runJlink(root ? resolve(root) : undefined, cable, directory, program ? builtBitstream : undefined));
        }
        if (message.type === 'hdl' || message.type === 'sta' || message.type === 'fpga' || message.type === 'fpga-timing') {
          if (!vscode.workspace.isTrusted) throw new Error('请在受信任的工作区运行 HDL 工具。');
          let snapshot = sources;
          const document = primary;
          const version = ++diagnosticVersion;
          const { options, lint } = message.payload as { options: BuildOptions; lint?: boolean };
          const config = configuration();
          const root = config.get<string>('toolchainPath', '').trim();
          const folder = document && (vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? dirname(document.fileName));
          const toolchain = root ? resolve(folder ?? '', root)
            : await bundled('hdl', [join('bin', 'yosys.exe'), join('bin', 'slang.exe')]);
          let timing: TimingOptions | undefined;
          let timingDemo = false;
          if (message.type === 'sta') {
            const liberty = config.get<string>('staLiberty', '').trim();
            const sdc = config.get<string>('staSdc', '').trim();
            const executable = config.get<string>('staExecutable', '').trim();
            const wslDistro = config.get<string>('staWslDistro', '').trim();
            const demoRoot = join(context.extensionPath, 'examples', 'sta');
            timingDemo = !liberty && !sdc && snapshot.length === 1 &&
              (!options.top || options.top === 'fifo_4x8') &&
              (document?.uri.toString() === example.toString() ||
                (snapshot[0].name === 'fifo_4x8.v' &&
                  snapshot[0].text.replaceAll('\r\n', '\n') === (await readFile(example.fsPath, 'utf8')).replaceAll('\r\n', '\n')));
            let libertyPath = liberty ? resolve(folder ?? '', liberty) : undefined;
            let sdcPath = sdc ? resolve(folder ?? '', sdc) : undefined;
            if (timingDemo) {
              libertyPath = join(demoRoot, 'fifo_demo.lib');
              sdcPath = join(demoRoot, 'fifo_4x8.sdc');
            } else {
              const choose = async (title: string, filter: string, extension: string) =>
                (await vscode.window.showOpenDialog({
                  title, canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                  defaultUri: folder ? vscode.Uri.file(folder) : undefined,
                  filters: { [filter]: [extension] },
                }))?.[0]?.fsPath;
              libertyPath ??= await choose('选择目标工艺的 Liberty 文件', 'Liberty', 'lib');
              if (libertyPath) sdcPath ??= await choose('选择当前设计的 SDC 约束文件', 'SDC', 'sdc');
              if (!libertyPath || !sdcPath || document !== primary || target !== panel) {
                await reply({ cancelled: true });
                return;
              }
              const workspace = document && vscode.workspace.getWorkspaceFolder(document.uri);
              if (workspace) {
                if (!liberty) await config.update('staLiberty', libertyPath, vscode.ConfigurationTarget.WorkspaceFolder);
                if (!sdc) await config.update('staSdc', sdcPath, vscode.ConfigurationTarget.WorkspaceFolder);
              }
            }
            timing = { liberty: libertyPath, sdc: sdcPath, executable: executable || undefined, wslDistro: wslDistro || undefined };
          }
          let fpga: FpgaOptions | undefined;
          let bitstreamDirectory: string | undefined;
          if (message.type === 'fpga' || message.type === 'fpga-timing') {
            if (message.type === 'fpga') builtBitstream = undefined;
            const openXc7Root = config.get<string>('fpgaToolchainPath', '').trim();
            const yosysRoot = config.get<string>('fpgaYosysPath', '').trim();
            if (!openXc7Root || !yosysRoot) {
              throw new Error('请配置 verilogWorkbench.fpgaToolchainPath（openXC7）和 verilogWorkbench.fpgaYosysPath（匹配的 OSS CAD Suite）。');
            }
            const part = config.get<string>('fpgaPart', '').trim().toLowerCase();
            const xdc = config.get<string>('fpgaXdc', '').trim();
            const demo = document?.uri.toString() === example.toString() && !part && !xdc;
            if (!demo && (!part || !xdc)) throw new Error('请同时配置 verilogWorkbench.fpgaPart 和 verilogWorkbench.fpgaXdc。');
            if (!demo && document?.uri.scheme !== 'file') throw new Error('请先将 FPGA 顶层源码保存到磁盘。');
            const demoRoot = join(context.extensionPath, 'examples', 'fpga');
            if (demo) {
              const name = 'fifo_zybo_z7_10.v';
              const path = join(demoRoot, name);
              snapshot = [...snapshot, { id: vscode.Uri.file(path).toString(), path, name, text: await readFile(path, 'utf8') }];
              options.top = 'fifo_zybo_z7_10';
            }
            fpga = {
              part: demo ? 'xc7z010clg400-1' : part,
              constraints: demo ? join(demoRoot, 'fifo_zybo_z7_10.xdc') : resolve(folder ?? '', xdc),
              openXc7Root: resolve(openXc7Root),
              yosysRoot: resolve(yosysRoot),
              timingOnly: message.type === 'fpga-timing',
            };
            bitstreamDirectory = demo ? join(context.globalStorageUri.fsPath, 'fpga') : join(folder!, 'build');
          }
          const result = await hdlJob(snapshot, options, !!lint, toolchain, lint ? undefined : stage => {
            if (target === panel) void target.webview.postMessage({ type: 'synthesis-stage', id: message.id, stage });
          }, timing, fpga);
          if (target === panel && version === diagnosticVersion) publish(result.diagnostics, snapshot);
          if (timing) await reply({
            ok: result.ok, log: result.timingReport ?? result.log, top: result.top,
            liberty: basename(timing.liberty), sdc: basename(timing.sdc),
            demo: timingDemo,
          });
          else if (fpga?.timingOnly) {
            await reply({ ok: result.ok, part: fpga.part, top: result.top, log: result.log, clocks: result.fpgaTiming });
          } else if (fpga && bitstreamDirectory) {
            let output: string | undefined;
            if (result.ok && result.bitstream && result.top && /^[\w$]+$/.test(result.top)) {
              await mkdir(bitstreamDirectory, { recursive: true });
              output = join(bitstreamDirectory, `${result.top}-${fpga.part}.bit`);
              const temporary = output + '.' + randomBytes(8).toString('hex') + '.tmp';
              try {
                await writeFile(temporary, result.bitstream);
                await rename(temporary, output);
              } finally {
                await rm(temporary, { force: true }).catch(() => {});
              }
              builtBitstream = { path: output, part: fpga.part };
              programmedSource = document;
            }
            await reply({ output, part: fpga.part, top: result.top, log: result.log });
          } else await reply(result);
        }
      } catch (error) {
        await reply(undefined, error instanceof Error ? error.message : String(error));
      }
    });
    target.onDidDispose(() => {
      receiver.dispose();
      panel = undefined;
      ready = false;
      ++refreshVersion;
      ++diagnosticVersion;
      diagnostics.clear();
    });
    try {
      const template = await readFile(vscode.Uri.joinPath(assets, 'index.html').fsPath, 'utf-8');
      target.webview.html = webviewHtml(target.webview, assets, template);
    } catch (error) {
      target.dispose();
      void vscode.window.showErrorMessage('无法加载 Verilog 工作台：' + String(error));
    }
  }), vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
    if (!panel || !contentChanges.length || !sources.some(source => source.id === document.uri.toString())) return;
    ++diagnosticVersion;
    void refresh();
  }), vscode.workspace.onDidCloseTextDocument(document => {
    if (panel && sources.some(source => source.id === document.uri.toString())) void refresh();
  }), vscode.workspace.onDidChangeConfiguration(event => {
    if (panel && (event.affectsConfiguration('verilogWorkbench.additionalSources') ||
      event.affectsConfiguration('verilogWorkbench.toolchainPath'))) void refresh();
  }), { dispose: () => panel?.dispose() });
}

function webviewHtml(webview: vscode.Webview, assets: vscode.Uri, template: string, testbench = false) {
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(assets, file)).toString();
  const nonce = randomBytes(18).toString('base64');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; connect-src ${webview.cspSource}; worker-src blob:`;
  return (testbench ? template.replace('class="vscode-workbench"', 'class="vscode-workbench testbench-view"') : template)
    .replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]+/, '$1' + csp)
    .replace('href="renderer.css"', `href="${uri('renderer.css')}"`)
    .replace('<script src="renderer.js"></script>',
      `<div id="worker-assets" hidden data-sim-worker="${uri('sim-worker.js')}" data-layout-worker="${uri('layout-worker.js')}" data-elk-worker="${uri('elk-worker.js')}"></div>
       <script nonce="${nonce}" type="module" src="${uri('renderer.js')}"></script>`);
}
