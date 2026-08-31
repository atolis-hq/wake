import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

interface AtomicWriteHandle {
  writeFile(contents: string, encoding: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface DirectorySyncHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DirectorySyncOperations {
  readonly platform: NodeJS.Platform;
  openParentDirectory(directory: string): Promise<DirectorySyncHandle>;
}

export interface AtomicWriteOperations extends DirectorySyncOperations {
  ensureDirectory(directory: string): Promise<void>;
  openTemporaryFile(path: string): Promise<AtomicWriteHandle>;
  rename(temporary: string, path: string): Promise<void>;
  removeTemporary(path: string): Promise<void>;
}

const nodeOperations: AtomicWriteOperations = {
  platform: process.platform,
  ensureDirectory: async (directory) => {
    await mkdir(directory, { recursive: true });
  },
  openTemporaryFile: (path) => open(path, 'wx'),
  rename,
  openParentDirectory: (directory) => open(directory, 'r'),
  removeTemporary: async (path) => {
    await rm(path, { force: true });
  },
};

export async function writeFileAtomically(
  path: string,
  contents: string,
  operations: AtomicWriteOperations = nodeOperations,
): Promise<void> {
  const directory = dirname(path);
  await operations.ensureDirectory(directory);
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    const handle = await operations.openTemporaryFile(temporary);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await operations.rename(temporary, path);
    await syncParentDirectory(directory, operations);
  } finally {
    await operations.removeTemporary(temporary);
  }
}

export async function syncParentDirectory(
  directory: string,
  operations: DirectorySyncOperations = nodeOperations,
): Promise<void> {
  let handle: DirectorySyncHandle | undefined;
  try {
    handle = await operations.openParentDirectory(directory);
    await handle.sync();
  } catch (error) {
    if (isUnsupportedWindowsDirectorySync(error, operations.platform)) return;
    throw error;
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

function isUnsupportedWindowsDirectorySync(error: unknown, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM';
}
