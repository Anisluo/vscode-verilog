import { spawn } from 'node:child_process';

export function run(executable: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs = 45_000) {
  return new Promise<{ code: number | null; log: string }>((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, env: environment, windowsHide: true });
    let log = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`HDL 工具超过 ${timeoutMs / 1000} 秒，已终止。`));
    }, timeoutMs);
    const receive = (data: string) => {
      log += data;
      if (log.length > 2_000_000) {
        child.kill();
        reject(new Error('HDL 工具输出超过 2 MB，已终止。'));
      }
    };
    child.stdout.setEncoding('utf8').on('data', receive);
    child.stderr.setEncoding('utf8').on('data', receive);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); resolveRun({ code, log }); });
  });
}
