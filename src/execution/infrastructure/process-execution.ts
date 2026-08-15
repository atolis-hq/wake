import { execa } from 'execa';

interface ProcessExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
  readonly failureKind?: 'output-limit';
  readonly failureMessage?: string;
}

export function runProcess(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  signal: AbortSignal,
  timeoutMs?: number,
): { readonly result: Promise<ProcessExecutionResult>; cancel(): Promise<void> } {
  const child = execa(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    shell: false,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cancelSignal: signal,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    reject: false,
    stripFinalNewline: false,
  });
  return {
    result: child.then((result) => ({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      ...(result.isMaxBuffer
        ? {
            failureKind: 'output-limit' as const,
            ...(result.shortMessage === undefined ? {} : { failureMessage: result.shortMessage }),
          }
        : {}),
    })),
    cancel: async () => void child.kill(),
  };
}
