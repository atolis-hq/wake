import { mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function acquireFileLock(path: string): Promise<{
  acquired: boolean;
  release(): Promise<void>;
}> {
  await mkdir(dirname(path), { recursive: true });

  try {
    const handle = await open(path, 'wx');

    return {
      acquired: true,
      async release() {
        await handle.close();
        await rm(path, { force: true });
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return {
        acquired: false,
        async release() {},
      };
    }

    throw error;
  }
}
