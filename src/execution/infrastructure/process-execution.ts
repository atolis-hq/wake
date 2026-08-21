import { spawn, type ChildProcess } from 'node:child_process';

// Agent CLIs can emit arbitrarily large machine-readable transcripts. Capture
// raw bytes ourselves so overflow never enters a third-party string buffer.
const maximumCapturedProcessOutputBytes = 1024 * 1024;

export interface ProcessExecutionResult {
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
  shell = false,
): { readonly result: Promise<ProcessExecutionResult>; cancel(): Promise<void> } {
  const child = spawn(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    shell,
    ...(shell && process.platform !== 'win32' ? { detached: true } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = captureProcessOutput(child, signal, timeoutMs, shell);
  return {
    result,
    cancel: async () => {
      terminate(child, shell);
    },
  };
}

function captureProcessOutput(
  child: ChildProcess,
  signal: AbortSignal,
  timeoutMs: number | undefined,
  shell: boolean,
): Promise<ProcessExecutionResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let error: Error | undefined;
    const terminateForOverflow = () => {
      overflowed = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      terminate(child, shell);
    };
    const capture = (destination: Buffer[]) => (chunk: Buffer) => {
      if (overflowed) return;
      const remaining = maximumCapturedProcessOutputBytes - capturedBytes;
      if (remaining <= 0 || chunk.length > remaining) {
        if (remaining > 0) destination.push(chunk.subarray(0, remaining));
        capturedBytes = maximumCapturedProcessOutputBytes;
        terminateForOverflow();
        return;
      }
      destination.push(chunk);
      capturedBytes += chunk.length;
    };
    child.stdout?.on('data', capture(stdout));
    child.stderr?.on('data', capture(stderr));
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate(child, shell);
          }, timeoutMs);
    const onAbort = () => terminate(child, shell);
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (caught) => {
      error = caught;
    });
    child.once('close', (exitCode) => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: error?.message ?? Buffer.concat(stderr).toString('utf8'),
        exitCode: exitCode ?? undefined,
        timedOut,
        ...(overflowed
          ? {
              failureKind: 'output-limit' as const,
              failureMessage: `Process output exceeded ${maximumCapturedProcessOutputBytes} bytes`,
            }
          : {}),
      });
    });
  });
}

function terminate(child: ChildProcess, shell = false): void {
  if (shell && process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid);
      return;
    } catch {
      // The process may have already exited; fall through to the direct signal.
    }
  }
  if (!child.killed && child.exitCode === null) child.kill();
}
