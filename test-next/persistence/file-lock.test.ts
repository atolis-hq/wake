import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireFileLock } from '../../src-next/persistence/index.js';
it('permits one file-lock owner at a time', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'wake-lock-')), 'locks', 'journal.lock');
  const first = await acquireFileLock(path);
  const second = await acquireFileLock(path);
  expect([first.acquired, second.acquired]).toEqual([true, false]);
  await first.release();
});
