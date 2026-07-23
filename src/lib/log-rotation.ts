import { renameSync, rmSync, statSync } from 'node:fs';

export const DEFAULT_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_LOG_ROTATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export function resolveLogMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WAKE_LOG_MAX_BYTES;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_LOG_MAX_BYTES;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOG_MAX_BYTES;
  }

  return Math.floor(parsed);
}

export function resolveLogRotateCheckIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WAKE_LOG_ROTATE_CHECK_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_LOG_ROTATE_CHECK_INTERVAL_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOG_ROTATE_CHECK_INTERVAL_MS;
  }

  return Math.floor(parsed);
}

export function rotateLogFileIfNeeded(
  logFile: string,
  maxBytes: number = DEFAULT_LOG_MAX_BYTES,
): boolean {
  try {
    if (statSync(logFile).size < maxBytes) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  const backupFile = `${logFile}.1`;
  rmSync(backupFile, { force: true });
  renameSync(logFile, backupFile);
  return true;
}
