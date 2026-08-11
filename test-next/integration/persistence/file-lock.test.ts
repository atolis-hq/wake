import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireFileLock } from '../../../src-next/persistence/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('permits one file-lock owner at a time', async () => {
  const path = await lockPath('journal.lock');
  const first = await acquireFileLock(path);
  try {
    const second = await acquireFileLock(path);
    expect([first.acquired, second.acquired]).toEqual([true, false]);
  } finally {
    await first.release();
  }
});

it('does not reclaim a stale attempt lock while its recorded local owner is alive', async () => {
  const path = await lockPath('attempt.lock');
  const first = await acquireFileLock(path, { now: new Date(0) });
  const second = await acquireFileLock(path, {
    now: new Date(61_000),
    staleAfterMs: 60_000,
    staleRequiresDeadProcess: true,
    isProcessAlive: () => true,
  });

  try {
    expect([first.acquired, second.acquired]).toEqual([true, false]);
  } finally {
    await first.release();
  }
});

it('reclaims a stale attempt lock only when its injected owner probe reports dead', async () => {
  const path = await lockPath('attempt.lock');
  const first = await acquireFileLock(path, { now: new Date(0) });
  const second = await acquireFileLock(path, {
    now: new Date(61_000),
    staleAfterMs: 60_000,
    staleRequiresDeadProcess: true,
    isProcessAlive: () => false,
  });

  try {
    expect([first.acquired, second.acquired]).toEqual([true, true]);
  } finally {
    await first.release();
    await second.release();
  }
});

it('fails closed when an attempt-owner liveness probe is indeterminate', async () => {
  const path = await lockPath('attempt.lock');
  const first = await acquireFileLock(path, { now: new Date(0) });
  const second = await acquireFileLock(path, {
    now: new Date(61_000),
    staleAfterMs: 60_000,
    staleRequiresDeadProcess: true,
    isProcessAlive: () => {
      const error = new Error('access denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    },
  });

  try {
    expect([first.acquired, second.acquired]).toEqual([true, false]);
  } finally {
    await first.release();
  }
});

async function lockPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-lock-'));
  roots.push(root);
  return join(root, 'locks', name);
}
