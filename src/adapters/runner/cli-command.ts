import { spawn } from 'node:child_process';
import { readProcessIdentity } from '../../lib/process-identity.js';

const TIMEOUT_KILL_GRACE_MS = 5_000;

export function runAgentCliCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
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

    const timeoutTimer =
      input.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_KILL_GRACE_MS);
          }, input.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', async (exitCode) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      await startNotification;
      if (startNotificationError !== undefined) {
        reject(startNotificationError);
        return;
      }
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        timedOut,
      });
    });
  });
}
