import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readSelfUpdateLedger,
  writeSelfUpdateLedger,
} from '../../src/adapters/fs/self-update-ledger.js';

describe('self-update ledger', () => {
  it('returns an empty ledger when no file exists yet', async () => {
    const wakeRoot = await mkdtemp(resolve(tmpdir(), 'wake-ledger-'));
    const ledgerPath = resolve(wakeRoot, 'self-update-ledger.json');

    const ledger = await readSelfUpdateLedger(ledgerPath);

    expect(ledger).toEqual({ lastAppliedTag: null, lastKnownGoodTag: null, badTags: [] });
  });

  it('round-trips a written ledger', async () => {
    const wakeRoot = await mkdtemp(resolve(tmpdir(), 'wake-ledger-'));
    const ledgerPath = resolve(wakeRoot, 'self-update-ledger.json');

    await writeSelfUpdateLedger(ledgerPath, {
      lastAppliedTag: 'v0.0.80',
      lastKnownGoodTag: 'v0.0.79',
      badTags: [
        { tag: 'v0.0.80', reason: 'health check failed', recordedAt: '2026-07-11T00:00:00.000Z' },
      ],
    });

    const ledger = await readSelfUpdateLedger(ledgerPath);

    expect(ledger.lastAppliedTag).toBe('v0.0.80');
    expect(ledger.lastKnownGoodTag).toBe('v0.0.79');
    expect(ledger.badTags).toHaveLength(1);
    expect(ledger.badTags[0]?.tag).toBe('v0.0.80');
  });
});
