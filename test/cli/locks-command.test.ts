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
  it('clears existing stale lock files', async () => {
    const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-locks-'));
    const locksDir = join(wakeRoot, 'locks');
    await mkdir(locksDir, { recursive: true });
    const lockFile1 = join(locksDir, 'atolis-hq__wake__issue-1.lock');
    const lockFile2 = join(locksDir, 'atolis-hq__wake__issue-2.lock');
    await writeFile(lockFile1, '', 'utf8');
    await writeFile(lockFile2, '', 'utf8');

    const result = await runLocksCommand({ args: ['clear'], locksDir });

    expect(result).toEqual({ status: 'cleared' });
    expect(await fileExists(lockFile1)).toBe(false);
    expect(await fileExists(lockFile2)).toBe(false);
  });

  it('reports not-locked when the locks directory does not exist', async () => {
    const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-locks-'));
    const locksDir = join(wakeRoot, 'locks');

    const result = await runLocksCommand({ args: ['clear'], locksDir });

    expect(result).toEqual({ status: 'not-locked' });
  });

  it('reports not-locked when there are no lock files', async () => {
    const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-locks-'));
    const locksDir = join(wakeRoot, 'locks');
    await mkdir(locksDir, { recursive: true });

    const result = await runLocksCommand({ args: ['clear'], locksDir });

    expect(result).toEqual({ status: 'not-locked' });
  });

  it('rejects unknown subcommands', async () => {
    await expect(
      runLocksCommand({ args: ['bogus'], locksDir: 'unused' }),
    ).rejects.toThrow(/Unknown locks subcommand/);
  });
});
