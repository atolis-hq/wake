import { describe, expect, it } from 'vitest';
import { createSelfUpdateApplication } from '../../../src-next/bootstrap/self-update-application.js';

function ledger(lastHealthyTag: string | null, calls: string[] = []) {
  return {
    read: async () => lastHealthyTag,
    begin: async (tag: string) => {
      calls.push(`begin:${tag}`);
    },
    write: async (tag: string) => {
      calls.push(`ledger:${tag}`);
    },
    recover: async () => null,
    isBad: async () => false,
    recordBad: async (tag: string) => {
      calls.push(`bad:${tag}`);
    },
  };
}

describe('self-update application: update operations', () => {
  it('refuses a dirty source checkout before applying any update', async () => {
    let updated = false;
    const application = createSelfUpdateApplication({
      ledger: ledger('v1'),
      source: {
        isClean: async () => false,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async () => {
          updated = true;
        },
        healthy: async () => true,
      },
    });
    await expect(application.update('v2')).rejects.toThrow('clean source checkout');
    expect(updated).toBe(false);
  });

  it('rolls back a failed health check and keeps the prior healthy ledger tag', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => false,
      },
    });
    await expect(application.update('v2')).rejects.toThrow('health verification');
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'checkout:v1', 'bad:v2']);
  });

  it('discovers a tag before applying a normal safe update', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
    });
    await expect(application.updateLatest()).resolves.toEqual({ tag: 'v2', updated: true });
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'ledger:v2']);
  });

  it('restores a pending update to the last healthy source revision before a new update', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: { ...ledger('v1', calls), recover: async () => 'v1' },
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
    });
    await application.update('v2');
    expect(calls).toEqual(['checkout:v1', 'begin:v2', 'checkout:v2', 'ledger:v2']);
  });

  it('skips a known bad tag unless an operator explicitly forces a retry', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: { ...ledger('v1', calls), isBad: async () => true },
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
    });
    await expect(application.update('v2')).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('self-update application: updateLatest with bad tag handling', () => {
  it('skips bad candidate tags and updates to the first good one', async () => {
    const calls: string[] = [];
    const isBadMap: Record<string, boolean> = {
      'v2.0.0': true,
      'v1.9.0': true,
      'v1.8.0': false,
    };
    const application = createSelfUpdateApplication({
      ledger: { ...ledger('v1', calls), isBad: async (tag) => isBadMap[tag] ?? false },
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2.0.0',
        candidateTags: async () => ['v2.0.0', 'v1.9.0', 'v1.8.0'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
    });
    await expect(application.updateLatest()).resolves.toEqual({
      tag: 'v1.8.0',
      updated: true,
    });
    expect(calls).toEqual(['begin:v1.8.0', 'checkout:v1.8.0', 'ledger:v1.8.0']);
  });

  it('reports no update when all candidate tags are bad', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: { ...ledger('v1', calls), isBad: async () => true },
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2.0.0',
        candidateTags: async () => ['v2.0.0', 'v1.9.0'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
    });
    await expect(application.updateLatest()).resolves.toEqual({
      tag: 'v2.0.0',
      updated: false,
    });
    expect(calls).toEqual([]);
  });

  it('reports no update when already on a good candidate tag', async () => {
    const calls: string[] = [];
    const isBadMap: Record<string, boolean> = {
      'v2.0.0': true,
      'v1.0.0': false,
    };
    const application = createSelfUpdateApplication({
      ledger: {
        ...ledger('v1.0.0', calls),
        isBad: async (tag) => isBadMap[tag] ?? false,
      },
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2.0.0',
        candidateTags: async () => ['v2.0.0', 'v1.0.0'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
    });
    await expect(application.updateLatest()).resolves.toEqual({
      tag: 'v1.0.0',
      updated: false,
    });
    expect(calls).toEqual([]);
  });
});
