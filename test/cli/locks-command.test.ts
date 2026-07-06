import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { runLocksCommand } from '../../src/cli/locks-command.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('locks command', () => {
  it('clears an existing stale lock file', async () => {
    const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-locks-'));
    const tickLockFile = join(wakeRoot, 'locks', 'tick.lock');
    await mkdir(join(wakeRoot, 'locks'), { recursive: true });
    await writeFile(tickLockFile, '', 'utf8');

    const result = await runLocksCommand({ args: ['clear'], tickLockFile });

    expect(result).toEqual({ status: 'cleared' });
    expect(await fileExists(tickLockFile)).toBe(false);
  });

  it('reports not-locked when there is nothing to clear', async () => {
    const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-locks-'));
    const tickLockFile = join(wakeRoot, 'locks', 'tick.lock');

    const result = await runLocksCommand({ args: ['clear'], tickLockFile });

    expect(result).toEqual({ status: 'not-locked' });
  });

  it('rejects unknown subcommands', async () => {
    await expect(
      runLocksCommand({ args: ['bogus'], tickLockFile: 'unused' }),
    ).rejects.toThrow(/Unknown locks subcommand/);
  });
});
