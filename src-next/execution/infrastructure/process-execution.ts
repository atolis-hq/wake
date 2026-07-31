import { spawn } from 'node:child_process';

interface ProcessExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export function runProcess(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  signal: AbortSignal,
): { readonly result: Promise<ProcessExecutionResult>; cancel(): Promise<void> } {
  const child = spawn(command, args, { cwd, shell: false });
  const result = new Promise<ProcessExecutionResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
  signal.addEventListener('abort', () => child.kill(), { once: true });
  return { result, cancel: async () => void child.kill() };
}
