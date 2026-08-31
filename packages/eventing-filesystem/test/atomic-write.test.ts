import { expect, it } from 'vitest';
import { type AtomicWriteOperations, writeFileAtomically } from '../src/atomic-write.js';

function failure(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function operations(
  calls: string[],
  options: {
    readonly directoryOpen?: () => Promise<unknown>;
    readonly directorySync?: () => Promise<void>;
    readonly platform?: NodeJS.Platform;
  } = {},
): AtomicWriteOperations {
  return {
    platform: options.platform ?? 'linux',
    ensureDirectory: async () => {
      calls.push('mkdir');
    },
    openTemporaryFile: async () => ({
      writeFile: async () => {
        calls.push('file.write');
      },
      sync: async () => {
        calls.push('file.sync');
      },
      close: async () => {
        calls.push('file.close');
      },
    }),
    rename: async () => {
      calls.push('rename');
    },
    openParentDirectory: async () => {
      calls.push('directory.open');
      await options.directoryOpen?.();
      return {
        sync: async () => {
          calls.push('directory.sync');
          await options.directorySync?.();
        },
        close: async () => {
          calls.push('directory.close');
        },
      };
    },
    removeTemporary: async () => {
      calls.push('temporary.remove');
    },
  };
}

it('syncs and closes the temporary file before rename and parent directory sync', async () => {
  const calls: string[] = [];

  await writeFileAtomically('/wake/projections/work.json', '{"value":1}', operations(calls));

  expect(calls).toEqual([
    'mkdir',
    'file.write',
    'file.sync',
    'file.close',
    'rename',
    'directory.open',
    'directory.sync',
    'directory.close',
    'temporary.remove',
  ]);
});

it('allows only the documented Windows EPERM directory-sync fallback', async () => {
  const calls: string[] = [];

  await expect(
    writeFileAtomically(
      '/wake/projections/work.json',
      '{"value":1}',
      operations(calls, {
        platform: 'win32',
        directoryOpen: async () => {
          throw failure('EPERM', 'directory handles cannot be synced on Windows');
        },
      }),
    ),
  ).resolves.toBeUndefined();

  expect(calls).toEqual([
    'mkdir',
    'file.write',
    'file.sync',
    'file.close',
    'rename',
    'directory.open',
    'temporary.remove',
  ]);
});

it('propagates a parent directory sync failure', async () => {
  const calls: string[] = [];

  await expect(
    writeFileAtomically(
      '/wake/projections/work.json',
      '{"value":1}',
      operations(calls, {
        directorySync: async () => {
          throw failure('EIO', 'directory sync failed');
        },
      }),
    ),
  ).rejects.toThrow('directory sync failed');

  expect(calls).toEqual([
    'mkdir',
    'file.write',
    'file.sync',
    'file.close',
    'rename',
    'directory.open',
    'directory.sync',
    'directory.close',
    'temporary.remove',
  ]);
});
