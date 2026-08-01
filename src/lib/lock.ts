import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FileLockMetadata {
  pid: number;
  acquiredAt: string;
  lockId?: string;
  commandLine?: string;
}

export type FileLockStaleReason =
  'missing' | 'invalid-metadata' | 'expired' | 'pid-not-alive' | 'pid-command-mismatch';

export interface ProcessInspector {
  isPidAlive: (pid: number) => boolean;
  readCommandLine: (pid: number) => string | undefined;
}

export interface FileLockStatus {
  present: boolean;
  active: boolean;
  metadata?: FileLockMetadata;
  ageMs?: number;
  commandLine?: string;
  staleReason?: FileLockStaleReason;
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
      ...(typeof record.commandLine === 'string' ? { commandLine: record.commandLine } : {}),
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

function readProcessCommandLine(pid: number): string | undefined {
  if (pid === process.pid) {
    return process.argv.join(' ');
  }

  try {
    return readFileSyncProcessCommandLine(pid);
  } catch {
    return undefined;
  }
}

function readFileSyncProcessCommandLine(pid: number): string | undefined {
  const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  const commandLine = raw.replace(/\0/g, ' ').trim();
  return commandLine.length === 0 ? undefined : commandLine;
}

function defaultProcessInspector(): ProcessInspector {
  return {
    isPidAlive,
    readCommandLine: readProcessCommandLine,
  };
}

async function readLockMetadata(path: string): Promise<FileLockMetadata | null> {
  try {
    return parseLockMetadata(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function readFileLockStatus(
  path: string,
  options?: {
    staleAfterMs?: number;
    now?: Date;
    processInspector?: ProcessInspector;
    expectedCommandIncludes?: string[];
  },
): Promise<FileLockStatus> {
  const metadata = await readLockMetadata(path);
  if (metadata === null) {
    try {
      await readFile(path, 'utf8');
      return { present: true, active: false, staleReason: 'invalid-metadata' };
    } catch {
      return { present: false, active: false, staleReason: 'missing' };
    }
  }

  const now = options?.now ?? new Date();
  const ageMs = now.getTime() - Date.parse(metadata.acquiredAt);
  if (options?.staleAfterMs !== undefined && ageMs >= options.staleAfterMs) {
    return { present: true, active: false, metadata, ageMs, staleReason: 'expired' };
  }

  const inspector = options?.processInspector ?? defaultProcessInspector();
  if (!inspector.isPidAlive(metadata.pid)) {
    return { present: true, active: false, metadata, ageMs, staleReason: 'pid-not-alive' };
  }

  const commandLine = inspector.readCommandLine(metadata.pid);
  if (
    commandLine !== undefined &&
    ((metadata.commandLine !== undefined && commandLine !== metadata.commandLine) ||
      (metadata.commandLine === undefined &&
        options?.expectedCommandIncludes !== undefined &&
        !options.expectedCommandIncludes.every((fragment) => commandLine.includes(fragment))))
  ) {
    return {
      present: true,
      active: false,
      metadata,
      ageMs,
      commandLine,
      staleReason: 'pid-command-mismatch',
    };
  }

  return {
    present: true,
    active: true,
    metadata,
    ageMs,
    ...(commandLine === undefined ? {} : { commandLine }),
  };
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
    commandLine: process.argv.join(' '),
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
      const status = await readFileLockStatus(path, {
        ...(options?.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
        now: options?.now ?? new Date(),
      });
      if (!status.active) {
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
