import type { TestbenchResult } from '../../src/testbench';
import type { BuildOptions, BuildResult, Diagnostic, Source, SynthesisStage } from '../../src/protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = acquireVsCodeApi();
const assets = document.querySelector<HTMLElement>('#worker-assets')!;
const workerNames = ['sim-worker', 'layout-worker', 'elk-worker'] as const;
const workerUrls = await Promise.all(workerNames.map(async name => {
  const response = await fetch(assets.getAttribute('data-' + name)!);
  if (!response.ok) throw new Error('无法加载工作台 Worker：' + name);
  return URL.createObjectURL(await response.blob());
})).catch(error => {
  document.getElementById('status')!.textContent = String(error);
  throw error;
});

let sequence = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; progress?: (stage: SynthesisStage) => void }>();
type SourceUpdate = (sources: Pick<Source, 'id' | 'name'>[]) => void;
let update: SourceUpdate | undefined;
let testbenchUpdate: ((result?: TestbenchResult) => void) | undefined;
window.addEventListener('message', ({ data }) => {
  if (data.type === 'sources') {
    update?.(data.sources);
  } else if (data.type === 'testbench') {
    testbenchUpdate?.(data.result);
  } else if (data.type === 'synthesis-stage') {
    pending.get(data.id)?.progress?.(data.stage);
  } else if (data.type === 'reply') {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  }
});

function ask<T>(type: string, payload?: unknown, progress?: (stage: SynthesisStage) => void): Promise<T> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: value => resolve(value as T), reject, progress });
    api.postMessage({ type, id, payload });
  });
}

export const workbench = {
  directory: () => ask<string | undefined>('directory'),
  hdl: (options: BuildOptions, lint: boolean, progress?: (stage: SynthesisStage) => void) =>
    ask<BuildResult>('hdl', { options, lint }, progress),
  sta: (options: BuildOptions, progress: (stage: SynthesisStage) => void) =>
    ask<{ cancelled: true } | { cancelled?: false; ok: boolean; log: string; top?: string; liberty: string; sdc: string; demo: boolean }>('sta', { options }, progress),
  fpga: (options: BuildOptions, progress: (stage: SynthesisStage) => void) =>
    ask<{ output?: string; part: string; top?: string; log: string }>('fpga', { options }, progress),
  jtag: (program: boolean) => ask<{ ok: boolean; log: string }>(program ? 'jtag-program' : 'jtag-detect'),
  elkWorkerUrl: workerUrls[2],
  worker: (name: 'layout-worker' | 'sim-worker') => new Worker(workerUrls[workerNames.indexOf(name)]),
  connect: (listener: SourceUpdate, onTestbench: (result?: TestbenchResult) => void) => {
    update = listener;
    testbenchUpdate = onTestbench;
    api.postMessage({ type: 'ready' });
  },
  reveal: (item: Diagnostic) => api.postMessage({ type: 'reveal', item }),
};
