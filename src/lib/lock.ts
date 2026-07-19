import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface FileLockMetadata {
  pid: number;
  acquiredAt: string;
  lockId?: string;
}

function parseLockMetadata(raw: string): FileLockMetadata | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (
      typeof record.pid !== 'number' ||
      !Number.isInteger(record.pid) ||
      typeof record.acquiredAt !== 'string'
    ) {
      return null;
    }

    const acquiredAtMs = Date.parse(record.acquiredAt);
    if (!Number.isFinite(acquiredAtMs)) {
      return null;
    }

    return {
      pid: record.pid,
      acquiredAt: record.acquiredAt,
      ...(typeof record.lockId === 'string' ? { lockId: record.lockId } : {}),
    };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

async function readLockMetadata(path: string): Promise<FileLockMetadata | null> {
  try {
    return parseLockMetadata(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function lockIsStale(path: string, staleAfterMs: number, now: Date): Promise<boolean> {
  const metadata = await readLockMetadata(path);
  if (metadata === null) {
    return true;
  }

  const ageMs = now.getTime() - Date.parse(metadata.acquiredAt);
  return ageMs >= staleAfterMs || !isPidAlive(metadata.pid);
}

export async function acquireFileLock(
  path: string,
  options?: {
    staleAfterMs?: number;
    now?: Date;
  },
): Promise<{
  acquired: boolean;
  metadata?: FileLockMetadata;
  release(): Promise<void>;
}> {
  await mkdir(dirname(path), { recursive: true });

  const metadata: FileLockMetadata = {
    pid: process.pid,
    acquiredAt: (options?.now ?? new Date()).toISOString(),
    lockId: randomUUID(),
  };

  async function tryAcquire(): Promise<{
    acquired: boolean;
    metadata?: FileLockMetadata;
    release(): Promise<void>;
  }> {
    const tempPath = join(dirname(path), `.tick-lock-${metadata.lockId}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(metadata)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });

    try {
      await link(tempPath, path);
    } finally {
      await rm(tempPath, { force: true });
    }

    return {
      acquired: true,
      metadata,
      async release() {
        const current = await readLockMetadata(path);
        if (
          current?.pid === metadata.pid &&
          current.acquiredAt === metadata.acquiredAt &&
          current.lockId === metadata.lockId
        ) {
          await rm(path, { force: true });
        }
      },
    };
  }

  try {
    return await tryAcquire();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (
        options?.staleAfterMs !== undefined &&
        (await lockIsStale(path, options.staleAfterMs, options.now ?? new Date()))
      ) {
        await rm(path, { force: true });
        try {
          return await tryAcquire();
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw retryError;
          }
        }
      }

      return {
        acquired: false,
        async release() {},
      };
    }

    throw error;
  }
}
