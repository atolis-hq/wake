import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { acquireFileLock } from '../../src/lib/lock.js';

describe('file lock', () => {
  it('writes owner PID and timestamp metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-lock-'));
    const lockPath = join(root, 'locks', 'tick.lock');

    const lock = await acquireFileLock(lockPath, {
      now: new Date('2026-07-05T12:00:00.000Z'),
    });

    expect(lock.acquired).toBe(true);
    const metadata = JSON.parse(await readFile(lockPath, 'utf8')) as {
      pid?: unknown;
      acquiredAt?: unknown;
    };
    expect(metadata.pid).toBe(process.pid);
    expect(metadata.acquiredAt).toBe('2026-07-05T12:00:00.000Z');

    await lock.release();
  });

  it('blocks acquisition when a fresh live lock exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-lock-'));
    const lockPath = join(root, 'locks', 'tick.lock');
    const first = await acquireFileLock(lockPath, {
      now: new Date('2026-07-05T12:00:00.000Z'),
    });

    const second = await acquireFileLock(lockPath, {
      staleAfterMs: 60_000,
      now: new Date('2026-07-05T12:00:01.000Z'),
    });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);

    await first.release();
  });

  it('reclaims an old lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-lock-'));
    const lockPath = join(root, 'locks', 'tick.lock');
    await acquireFileLock(lockPath, {
      now: new Date('2026-07-05T12:00:00.000Z'),
    });

    const reclaimed = await acquireFileLock(lockPath, {
      staleAfterMs: 1_000,
      now: new Date('2026-07-05T12:01:00.000Z'),
    });

    expect(reclaimed.acquired).toBe(true);
    expect(reclaimed.metadata?.acquiredAt).toBe('2026-07-05T12:01:00.000Z');

    await reclaimed.release();
  });

  it('reclaims a lock owned by a dead PID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-lock-'));
    const lockPath = join(root, 'tick.lock');
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 99_999_999,
        acquiredAt: '2026-07-05T12:00:00.000Z',
      })}\n`,
      'utf8',
    );

    const reclaimed = await acquireFileLock(lockPath, {
      staleAfterMs: 60_000,
      now: new Date('2026-07-05T12:00:01.000Z'),
    });

    expect(reclaimed.acquired).toBe(true);

    await reclaimed.release();
  });

  it('reclaims legacy invalid lock files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-lock-'));
    const lockPath = join(root, 'tick.lock');
    await writeFile(lockPath, '', 'utf8');

    const reclaimed = await acquireFileLock(lockPath, {
      staleAfterMs: 60_000,
      now: new Date('2026-07-05T12:00:01.000Z'),
    });

    expect(reclaimed.acquired).toBe(true);

    await reclaimed.release();
  });
});
