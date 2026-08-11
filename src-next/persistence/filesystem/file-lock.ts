import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FileLockMetadata {
  readonly pid: number;
  readonly acquiredAt: string;
  readonly lockId: string;
}

export interface FileLockOptions {
  readonly staleAfterMs?: number;
  readonly now?: Date;
  /** Attempt locks may not steal a stale file while its recorded local owner still lives. */
  readonly staleRequiresDeadProcess?: boolean;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export async function acquireFileLock(
  path: string,
  options?: FileLockOptions,
) {
  await mkdir(dirname(path), { recursive: true });
  const metadata: FileLockMetadata = {
    pid: process.pid,
    acquiredAt: (options?.now ?? new Date()).toISOString(),
    lockId: randomUUID(),
  };
  const attempt = async () => {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return {
      acquired: true,
      metadata,
      async release() {
        try {
          const current = JSON.parse(await readFile(path, 'utf8')) as FileLockMetadata;
          if (current.lockId === metadata.lockId) await rm(path, { force: true });
        } catch {
          /* already released */
        }
      },
    };
  };
  try {
    return await attempt();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (options?.staleAfterMs !== undefined) {
      try {
        const prior = JSON.parse(await readFile(path, 'utf8')) as FileLockMetadata;
        if (
          (options.now ?? new Date()).getTime() - Date.parse(prior.acquiredAt) >=
          options.staleAfterMs
        ) {
          if (options.staleRequiresDeadProcess && ownerMayBeAlive(options, prior.pid))
            return { acquired: false, async release() {} };
          await rm(path, { force: true });
          return attempt();
        }
      } catch {
        await rm(path, { force: true });
        return attempt();
      }
    }
    return { acquired: false, async release() {} };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownerMayBeAlive(options: FileLockOptions, pid: number): boolean {
  try {
    return (options.isProcessAlive ?? isProcessAlive)(pid);
  } catch {
    // Permission and platform-probe failures are indeterminate: never steal a live owner's lock.
    return true;
  }
}

export async function withFileLock<Value>(
  path: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  const lock = await acquireFileLock(path, { staleAfterMs: 60_000 });
  if (!lock.acquired) throw new Error(`File lock is already held: ${path}`);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}
