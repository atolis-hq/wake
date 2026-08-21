import { spawn, type ChildProcess } from 'node:child_process';

// Agent CLIs can emit arbitrarily large machine-readable transcripts. Capture
// raw bytes ourselves so overflow never enters a third-party string buffer.
const maximumCapturedProcessOutputBytes = 1024 * 1024;

export interface ProcessTimeouts {
  readonly idleMs?: number;
  readonly hardMs?: number;
  readonly cancellationGraceMs?: number;
}

interface ProcessExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
  readonly timeoutKind?: 'idle' | 'hard';
  readonly failureKind?: 'output-limit';
  readonly failureMessage?: string;
}

export function runProcess(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  signal: AbortSignal,
  timeouts?: ProcessTimeouts,
): { readonly result: Promise<ProcessExecutionResult>; cancel(): Promise<void> } {
  const child = spawn(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return captureProcessOutput(child, signal, timeouts);
}

// Lifecycle coordination must share these closures so first-event-wins is atomic.
// eslint-disable-next-line max-lines-per-function
function captureProcessOutput(
  child: ChildProcess,
  signal: AbortSignal,
  timeouts: ProcessTimeouts | undefined,
): { readonly result: Promise<ProcessExecutionResult>; cancel(): Promise<void> } {
  let terminatePromise: Promise<void> | undefined;
  const terminate = () =>
    (terminatePromise ??= terminateGracefully(child, timeouts?.cancellationGraceMs));
  let cancel = terminate;
  // eslint-disable-next-line max-lines-per-function
  const result = new Promise<ProcessExecutionResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let timeoutKind: 'idle' | 'hard' | undefined;
    let overflowed = false;
    let error: Error | undefined;
    let settled = false;
    let idleTimeout: NodeJS.Timeout | undefined;
    let hardTimeout: NodeJS.Timeout | undefined;
    const clearTimeouts = () => {
      if (idleTimeout !== undefined) clearTimeout(idleTimeout);
      if (hardTimeout !== undefined) clearTimeout(hardTimeout);
    };
    const terminateForTimeout = (kind: 'idle' | 'hard') => {
      if (settled) return;
      settled = true;
      timedOut = true;
      timeoutKind = kind;
      clearTimeouts();
      void terminate();
    };
    const resetIdleTimeout = () => {
      if (settled || timeouts?.idleMs === undefined) return;
      if (idleTimeout !== undefined) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => terminateForTimeout('idle'), timeouts.idleMs);
    };
    const terminateForOverflow = () => {
      if (settled) return;
      settled = true;
      overflowed = true;
      clearTimeouts();
      child.stdout?.destroy();
      child.stderr?.destroy();
      void terminate();
    };
    const capture = (destination: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      resetIdleTimeout();
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
    resetIdleTimeout();
    if (timeouts?.hardMs !== undefined)
      hardTimeout = setTimeout(() => terminateForTimeout('hard'), timeouts.hardMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeouts();
      void terminate();
    };
    cancel = () => {
      if (!settled) {
        settled = true;
        clearTimeouts();
      }
      return terminate();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.once('error', (caught) => {
      error = caught;
    });
    child.once('close', (exitCode) => {
      if (!settled) settled = true;
      clearTimeouts();
      signal.removeEventListener('abort', onAbort);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: error?.message ?? Buffer.concat(stderr).toString('utf8'),
        exitCode: exitCode ?? undefined,
        timedOut,
        ...(timeoutKind === undefined ? {} : { timeoutKind }),
        ...(overflowed
          ? {
              failureKind: 'output-limit' as const,
              failureMessage: `Process output exceeded ${maximumCapturedProcessOutputBytes} bytes`,
            }
          : {}),
      });
    });
  });
  return { result, cancel };
}

async function terminateGracefully(
  child: ChildProcess,
  cancellationGraceMs: number | undefined,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  // Windows does not distinguish these signals, so its SIGTERM already has
  // immediate-kill semantics and waiting would not make cancellation gentler.
  if (process.platform === 'win32' || cancellationGraceMs === undefined) return;
  await waitForExit(child, cancellationGraceMs);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    child.once('exit', done);

    function done(): void {
      clearTimeout(timeout);

      child.removeListener('exit', done);
      resolve();
    }
  });
}
