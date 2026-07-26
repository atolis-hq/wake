import { spawn } from 'node:child_process';
import { readProcessIdentity } from '../../lib/process-identity.js';

const TIMEOUT_KILL_GRACE_MS = 5_000;

export function runAgentCliCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  cancellationSignal?: AbortSignal;
  onProcessStart?: (identity: { pid: number; processStartedAt: string }) => Promise<void>;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let canceled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let startNotification: Promise<void> = Promise.resolve();
    let startNotificationError: unknown;

    if (input.onProcessStart !== undefined && child.pid !== undefined) {
      const identity = readProcessIdentity(child.pid);
      if (identity !== null) {
        startNotification = input.onProcessStart(identity).catch((error: unknown) => {
          startNotificationError = error;
        });
      }
    }

    const terminate = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_KILL_GRACE_MS);
    };

    const timeoutTimer =
      input.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
          }, input.timeoutMs);

    const abortListener = () => {
      canceled = true;
      terminate();
    };
    input.cancellationSignal?.addEventListener('abort', abortListener, { once: true });
    if (input.cancellationSignal?.aborted === true) {
      abortListener();
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      input.cancellationSignal?.removeEventListener('abort', abortListener);
      reject(error);
    });
    child.on('close', async (exitCode) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      input.cancellationSignal?.removeEventListener('abort', abortListener);
      await startNotification;
      if (startNotificationError !== undefined) {
        reject(startNotificationError);
        return;
      }
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        timedOut: timedOut || canceled,
      });
    });
  });
}
