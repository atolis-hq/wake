import { spawn } from 'node:child_process';

interface ProcessExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export function runProcess(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  signal: AbortSignal,
  timeoutMs?: number,
): { readonly result: Promise<ProcessExecutionResult>; cancel(): Promise<void> } {
  const child = spawn(command, args, { cwd, shell: false });
  const result = new Promise<ProcessExecutionResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', (error) => {
      if (timeout !== undefined) clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (exitCode) => {
      if (timeout !== undefined) clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
  signal.addEventListener('abort', () => child.kill(), { once: true });
  return { result, cancel: async () => void child.kill() };
}
