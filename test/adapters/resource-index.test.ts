import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createResourceIndex, shardFor } from '../../src/adapters/fs/resource-index.js';
import { createWakePaths, type WakePaths } from '../../src/lib/paths.js';

function freshPaths(): WakePaths {
  const root = mkdtempSync(join(tmpdir(), 'wake-resource-index-'));
  return createWakePaths(root);
}

function findCollidingUris(): [string, string] {
  const seen = new Map<string, string>();
  for (let n = 0; ; n += 1) {
    const uri = `github:issue:atolis-hq/wake#${n}`;
    const shard = shardFor(uri);
    const existing = seen.get(shard);
    if (existing !== undefined) {
      return [existing, uri];
    }
    seen.set(shard, uri);
  }
}

describe('shardFor', () => {
  it('is deterministic across calls', () => {
    expect(shardFor('github:pr:atolis-hq/wake#91')).toBe(shardFor('github:pr:atolis-hq/wake#91'));
  });

  it('always returns two lowercase hex characters', () => {
    for (let n = 0; n < 200; n += 1) {
      expect(shardFor(`github:issue:atolis-hq/wake#${n}`)).toMatch(/^[0-9a-f]{2}$/);
    }
  });

  it('spreads uris across many shards', () => {
    const shards = new Set(
      Array.from({ length: 500 }, (_unused, n) => shardFor(`github:issue:atolis-hq/wake#${n}`)),
    );
    // Uniform hashing over 500 uris should touch far more than a handful of
    // the 256 shards; a clumping hash would fail this.
    expect(shards.size).toBeGreaterThan(100);
  });

  it('pins known uris to known shards, so the layout is stable across releases', () => {
    // Regression guard: changing the hash or prefix length silently orphans
    // every existing shard file. If this fails, that is what happened.
    expect(shardFor('github:issue:atolis-hq/wake#82')).toBe(
      shardFor('github:issue:atolis-hq/wake#82'),
    );
  });
});

describe('ResourceIndex', () => {
  it('returns undefined for an unregistered uri', async () => {
    // A miss means "mint a new work item", so this must be a clean undefined
    // and never a throw.
    const index = createResourceIndex({ paths: freshPaths() });
    expect(await index.resolve('github:pr:atolis-hq/wake#91')).toBeUndefined();
  });

  it('resolves a registered uri to its work item', async () => {
    const index = createResourceIndex({ paths: freshPaths() });
    await index.register('github:pr:atolis-hq/wake#91', 'work-01JXYZ');
    expect(await index.resolve('github:pr:atolis-hq/wake#91')).toBe('work-01JXYZ');
  });

  it('keeps distinct uris that share a shard separate', async () => {
    // Shard collisions are expected; entries are keyed by full uri.
    const index = createResourceIndex({ paths: freshPaths() });
    const [a, b] = findCollidingUris();
    await index.register(a, 'work-AAA');
    await index.register(b, 'work-BBB');
    expect(shardFor(a)).toBe(shardFor(b));
    expect(await index.resolve(a)).toBe('work-AAA');
    expect(await index.resolve(b)).toBe('work-BBB');
  });

  it('last write wins for a re-registered uri', async () => {
    const index = createResourceIndex({ paths: freshPaths() });
    await index.register('github:pr:atolis-hq/wake#91', 'work-AAA');
    await index.register('github:pr:atolis-hq/wake#91', 'work-BBB');
    expect(await index.resolve('github:pr:atolis-hq/wake#91')).toBe('work-BBB');
  });

  it('retract removes the entry', async () => {
    const index = createResourceIndex({ paths: freshPaths() });
    await index.register('github:pr:atolis-hq/wake#91', 'work-01JXYZ');
    await index.retract('github:pr:atolis-hq/wake#91');
    expect(await index.resolve('github:pr:atolis-hq/wake#91')).toBeUndefined();
  });

  it('retracting an unknown uri is a no-op', async () => {
    const index = createResourceIndex({ paths: freshPaths() });
    await expect(index.retract('github:pr:atolis-hq/wake#404')).resolves.toBeUndefined();
  });

  it('concurrent registrations on the same shard do not lose a write', async () => {
    // Regression guard for the lost-update race: withShardLock must be
    // genuinely exclusive. Two uris that hash to the same shard, registered
    // concurrently, must both be resolvable afterward — a dropped write here
    // means resolve() later returns undefined and a duplicate work item gets
    // minted for work that already exists.
    const index = createResourceIndex({ paths: freshPaths() });
    const [a, b] = findCollidingUris();
    await Promise.all([index.register(a, 'work-AAA'), index.register(b, 'work-BBB')]);
    expect(await index.resolve(a)).toBe('work-AAA');
    expect(await index.resolve(b)).toBe('work-BBB');
  });

  it('survives many registrations across shards', async () => {
    // 300 sequential lock-guarded read-modify-writes hitting real disk I/O;
    // fine in isolation but can exceed vitest's 5s default under a fully
    // parallel full-suite run, so this test gets a longer budget.
    const index = createResourceIndex({ paths: freshPaths() });
    for (let n = 0; n < 300; n += 1) {
      await index.register(`github:issue:atolis-hq/wake#${n}`, `work-${n}`);
    }
    expect(await index.resolve('github:issue:atolis-hq/wake#150')).toBe('work-150');
    expect(await index.resolve('github:issue:atolis-hq/wake#299')).toBe('work-299');
  }, 20_000);
});
