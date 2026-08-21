import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Agent CLIs can emit arbitrarily large machine-readable transcripts. Capture
// raw bytes ourselves so overflow never enters a third-party string buffer.
const maximumCapturedProcessOutputBytes = 1024 * 1024;

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
  // Concurrent runs each get their own npm cache, keyed off their workspace
  // path (a sibling directory, never inside the git-tracked workspace itself),
  // so concurrent `npm ci` calls across workspaces can no longer race the
  // same on-disk cache -- the corruption that motivated this. Seeded once
  // from the long-lived shared cache so a workspace's first install is still
  // a local copy, not a fresh download of packages this box already has.
  const child = spawn(command, args, {
    ...(cwd === undefined ? {} : { cwd, env: { ...process.env, ...npmCacheEnv(cwd) } }),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = captureProcessOutput(child, signal, timeoutMs);
  return {
    result,
    cancel: async () => {
      terminate(child);
    },
  };
}

// Seeds a workspace's isolated cache from the shared one on first use only
// (existsSync guards every later spawn for the same workspace to a cheap
// stat). Best-effort: an unreadable or absent shared cache just leaves the
// workspace cache to build up from a real install, same as before this fix.
function npmCacheEnv(cwd: string): { readonly NPM_CONFIG_CACHE: string } {
  const isolated = `${cwd}.npm-cache`;
  if (!existsSync(isolated)) {
    const shared = process.env.NPM_CONFIG_CACHE ?? join(homedir(), '.npm');
    try {
      if (existsSync(shared)) cpSync(shared, isolated, { recursive: true });
    } catch {
      // Fall through to an empty isolated cache.
    }
  }
  return { NPM_CONFIG_CACHE: isolated };
}

function captureProcessOutput(
  child: ChildProcess,
  signal: AbortSignal,
  timeoutMs: number | undefined,
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
      terminate(child);
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
            terminate(child);
          }, timeoutMs);
    const onAbort = () => terminate(child);
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

function terminate(child: ChildProcess): void {
  if (!child.killed && child.exitCode === null) child.kill();
}
