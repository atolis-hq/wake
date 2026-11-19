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
