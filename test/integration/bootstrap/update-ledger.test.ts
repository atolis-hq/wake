import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearBadUpdateTag, createUpdateLedger } from '../../../src/bootstrap/update-ledger.js';

describe('target update ledger', () => {
  it('stores only the last healthy application tag beneath .wake, not in canonical events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-update-ledger-'));
    const ledger = createUpdateLedger(root);
    await expect(ledger.read()).resolves.toBeNull();
    await ledger.write('v2.0.0');
    await expect(ledger.read()).resolves.toBe('v2.0.0');
    expect(await readFile(join(root, '.wake', 'update-ledger.json'), 'utf8')).toContain('v2.0.0');
  });

  it('records an interrupted update separately and restores the previous healthy tag on recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-update-ledger-'));
    const ledger = createUpdateLedger(root);
    await ledger.write('v1.0.0');
    await ledger.begin('v2.0.0');
    await expect(ledger.recover()).resolves.toBe('v1.0.0');
    await expect(ledger.read()).resolves.toBe('v1.0.0');
    await expect(ledger.recover()).resolves.toBeNull();
  });
  it('persists a rejected tag outside canonical state so automatic update checks can skip it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-update-ledger-'));
    const ledger = createUpdateLedger(root);
    await ledger.recordBad('v2.0.0');
    await expect(ledger.isBad('v2.0.0')).resolves.toBe(true);
    await expect(ledger.isBad('v2.0.1')).resolves.toBe(false);
  });
});

it('clears an exact bad tag while preserving healthy, pending, and other bad tags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-update-ledger-'));
  const ledger = createUpdateLedger(root);
  await ledger.write('v1');
  await ledger.begin('v3');
  await ledger.recordBad('v2');
  await ledger.recordBad('v20');
  expect(await clearBadUpdateTag(root, 'v2')).toBe(true);
  const path = join(root, '.wake', 'update-ledger.json');
  const state = await readFile(path, 'utf8');
  expect(JSON.parse(state)).toEqual({ lastHealthyTag: 'v1', pendingTag: 'v3', badTags: ['v20'] });
  expect(await clearBadUpdateTag(root, 'v2')).toBe(false);
  expect(await readFile(path, 'utf8')).toBe(state);
});

it('does not create a ledger when clearing an absent tag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-update-ledger-'));
  expect(await clearBadUpdateTag(root, 'v2')).toBe(false);
  await expect(readFile(join(root, '.wake', 'update-ledger.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it.each(['begin', 'write', 'recordBad', 'recover'] as const)(
  'preserves concurrent updater %s changes when clearing a bad tag',
  async (operation) => {
    const root = await mkdtemp(join(tmpdir(), 'wake-update-ledger-'));
    const ledger = createUpdateLedger(root);
    await ledger.write('v1');
    await ledger.begin('v2');
    await ledger.recordBad('rejected');
    await ledger.recordBad('other');
    const updater = createUpdateLedger(root);

    const [cleared] = await Promise.all([
      clearBadUpdateTag(root, 'rejected'),
      operation === 'recover' ? updater.recover() : updater[operation]('v3'),
    ]);

    expect(cleared).toBe(true);
    expect(JSON.parse(await readFile(join(root, '.wake', 'update-ledger.json'), 'utf8'))).toEqual({
      lastHealthyTag: operation === 'write' ? 'v3' : 'v1',
      ...(operation === 'begin' ? { pendingTag: 'v3' } : {}),
      ...(operation === 'recordBad' ? { pendingTag: 'v2' } : {}),
      badTags: operation === 'recordBad' ? ['other', 'v3'] : ['other'],
    });
  },
);

it('retains all rejected releases recorded concurrently by separate ledger instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-update-ledger-'));
  const tags = Array.from({ length: 12 }, (_, index) => `v${index}`);
  await Promise.all(tags.map((tag) => createUpdateLedger(root).recordBad(tag)));
  const state = JSON.parse(await readFile(join(root, '.wake', 'update-ledger.json'), 'utf8'));
  expect(state.badTags.sort()).toEqual(tags.sort());
});
