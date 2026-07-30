import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
export interface FileLockMetadata {
  readonly pid: number;
  readonly acquiredAt: string;
  readonly lockId: string;
}
export async function acquireFileLock(
  path: string,
  options?: { staleAfterMs?: number; now?: Date },
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
