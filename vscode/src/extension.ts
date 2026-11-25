import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { hdlJob } from '../../src/backend';
import { runTestbench } from '../../src/testbench';
import type { TestbenchResult } from '../../src/testbench';
import type { BuildOptions, Diagnostic, Source } from '../../src/protocol';

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
  let needsBuild = false;
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

  async function refresh(build = false) {
    needsBuild ||= build;
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
      const synthesize = needsBuild;
      needsBuild = false;
      await target.webview.postMessage({ type: 'sources', sources: sources.map(({ id, name }) => ({ id, name })), build: synthesize });
    } catch (error) {
      if (target !== panel || version !== refreshVersion) return;
      needsBuild = false;
      sources = [];
      ++diagnosticVersion;
      diagnostics.clear();
      void target.webview.postMessage({ type: 'sources', sources, build: false });
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
      result = await runTestbench(snapshot, top, bin);
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
    needsBuild = true;
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
        if (message.type === 'directory') {
          const choice = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true });
          await reply(choice?.[0]?.fsPath);
        }
        if (message.type === 'hdl') {
          if (!vscode.workspace.isTrusted) throw new Error('请在受信任的工作区运行 HDL 工具。');
          const snapshot = sources;
          const version = ++diagnosticVersion;
          const { options, lint } = message.payload as { options: BuildOptions; lint: boolean };
          const root = configuration().get<string>('toolchainPath', '').trim();
          const folder = primary && (vscode.workspace.getWorkspaceFolder(primary.uri)?.uri.fsPath ?? dirname(primary.fileName));
          const toolchain = root ? resolve(folder ?? '', root)
            : await bundled('hdl', [join('bin', 'yosys.exe'), join('bin', 'slang.exe')]);
          const result = await hdlJob(snapshot, options, lint, toolchain);
          if (target === panel && version === diagnosticVersion) publish(result.diagnostics, snapshot);
          await reply(result);
        }
      } catch (error) {
        await reply(undefined, error instanceof Error ? error.message : String(error));
      }
    });
    target.onDidDispose(() => {
      receiver.dispose();
      panel = undefined;
      ready = false;
      needsBuild = false;
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
    if (panel && event.affectsConfiguration('verilogWorkbench')) void refresh();
  }), { dispose: () => panel?.dispose() });
}

function webviewHtml(webview: vscode.Webview, assets: vscode.Uri, template: string, testbench = false) {
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(assets, file)).toString();
  const nonce = randomBytes(18).toString('base64');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; connect-src ${webview.cspSource}; worker-src blob:`;
  return (testbench ? template.replace('class="vscode-workbench"', 'class="vscode-workbench testbench-view"') : template)
    .replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]+/, '$1' + csp)
    .replace('href="renderer.css"', `href="${uri('renderer.css')}"`)
    .replace('src="color-disc-icon.png"', `src="${uri('color-disc-icon.png')}"`)
    .replace('<script src="renderer.js"></script>',
      `<div id="worker-assets" hidden data-sim-worker="${uri('sim-worker.js')}" data-layout-worker="${uri('layout-worker.js')}" data-elk-worker="${uri('elk-worker.js')}"></div>
       <script nonce="${nonce}" type="module" src="${uri('renderer.js')}"></script>`);
}
