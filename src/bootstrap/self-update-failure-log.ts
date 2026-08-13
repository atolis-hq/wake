import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface SelfUpdateFailure {
  readonly tag: string;
  readonly message: string;
  readonly occurredAt: string;
}

export interface SelfUpdateFailureLog {
  record(tag: string, error: unknown): Promise<void>;
  clear(): Promise<void>;
  read(): Promise<SelfUpdateFailure | null>;
}

/**
 * Persists the most recent self-update rollback so it can surface on the
 * operator health screen instead of relying on a third-party notification —
 * cleared the moment a later deploy succeeds.
 */
export function createSelfUpdateFailureLog(
  wakeRoot: string,
  now: () => string = () => new Date().toISOString(),
): SelfUpdateFailureLog {
  const path = join(wakeRoot, '.wake', 'self-update-failure.json');
  return {
    async record(tag, error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      const failure: SelfUpdateFailure = { tag, message, occurredAt: now() };
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(failure)}\n`, 'utf8');
      await rename(temporary, path);
    },
    async clear() {
      await rm(path, { force: true });
    },
    async read() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as SelfUpdateFailure;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
}
