import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSelfUpdateFailureLog } from '../../../src-next/bootstrap/self-update-failure-log.js';

describe('self-update failure log', () => {
  it('reports no failure until one is recorded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-self-update-failure-'));
    const log = createSelfUpdateFailureLog(root);
    await expect(log.read()).resolves.toBeNull();
  });

  it('persists a recorded failure beneath .wake for the health check to read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-self-update-failure-'));
    const log = createSelfUpdateFailureLog(root, () => '2026-08-04T00:00:00.000Z');
    await log.record('v2.0.0', new Error('docker build failed'));
    await expect(log.read()).resolves.toEqual({
      tag: 'v2.0.0',
      message: expect.stringContaining('docker build failed'),
      occurredAt: '2026-08-04T00:00:00.000Z',
    });
    expect(await readFile(join(root, '.wake', 'self-update-failure.json'), 'utf8')).toContain(
      'v2.0.0',
    );
  });

  it('stringifies a non-Error failure value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-self-update-failure-'));
    const log = createSelfUpdateFailureLog(root);
    await log.record('v2.0.0', 'boom');
    await expect(log.read()).resolves.toMatchObject({ tag: 'v2.0.0', message: 'boom' });
  });

  it('clears a recorded failure once a later deploy succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-self-update-failure-'));
    const log = createSelfUpdateFailureLog(root);
    await log.record('v2.0.0', new Error('docker build failed'));
    await log.clear();
    await expect(log.read()).resolves.toBeNull();
  });

  it('clearing an already-clear log is a no-op', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-self-update-failure-'));
    const log = createSelfUpdateFailureLog(root);
    await expect(log.clear()).resolves.toBeUndefined();
  });
});
