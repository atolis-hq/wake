import { createHash } from 'node:crypto';

import { acquireFileLock } from '../../lib/lock.js';
import { readJsonFile, writeJsonFile } from '../../lib/json-file.js';
import type { WakePaths } from '../../lib/paths.js';
import type { ResourceIndex } from '../../core/contracts.js';

type ShardContents = Record<string, string>;

/**
 * Addresses a resource uri to one of 256 shards.
 *
 * The uri is hashed as opaque bytes — this never splits on ':' and never
 * inspects the locator, which is what lets core shard without violating
 * "core compares uris for equality only" (ADR 0001 §1). Hashing also yields
 * a filename-safe shard name for free; the raw uri contains '/', '#' and ':'
 * and could not be a filename without escaping.
 */
export function shardFor(resourceUri: string): string {
  return createHash('sha256').update(resourceUri, 'utf8').digest('hex').slice(0, 2);
}

async function readShard(file: string): Promise<ShardContents> {
  try {
    return await readJsonFile<ShardContents>(file);
  } catch {
    return {};
  }
}

// acquireFileLock is a non-blocking try-lock: when contended it returns
// { acquired: false } immediately rather than waiting. register/retract have
// no sensible "try again later" behavior at their call sites — skipping the
// write here is exactly the silent-drop corruption this index exists to
// avoid — so withShardLock must retry until it actually holds the lock.
// staleAfterMs (60s) already reclaims a lock from a crashed holder, so this
// bound only needs to outlast normal contention between live processes, not
// a dead one.
const SHARD_LOCK_RETRY_INTERVAL_MS = 25;
const SHARD_LOCK_RETRY_BUDGET_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createResourceIndex({ paths }: { paths: WakePaths }): ResourceIndex {
  async function withShardLock<T>(shard: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = `${paths.resourceIndexShardFile(shard)}.lock`;
    const deadline = Date.now() + SHARD_LOCK_RETRY_BUDGET_MS;

    for (;;) {
      const lock = await acquireFileLock(lockPath, { staleAfterMs: 60_000 });
      if (lock.acquired) {
        try {
          return await fn();
        } finally {
          await lock.release();
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `resource-index: timed out after ${SHARD_LOCK_RETRY_BUDGET_MS}ms waiting for lock on shard '${shard}' (${lockPath})`,
        );
      }

      await delay(SHARD_LOCK_RETRY_INTERVAL_MS);
    }
  }

  return {
    async resolve(resourceUri: string): Promise<string | undefined> {
      const shard = await readShard(paths.resourceIndexShardFile(shardFor(resourceUri)));
      return shard[resourceUri];
    },

    async register(resourceUri: string, workItemKey: string): Promise<void> {
      const shard = shardFor(resourceUri);
      const file = paths.resourceIndexShardFile(shard);
      await withShardLock(shard, async () => {
        const contents = await readShard(file);
        contents[resourceUri] = workItemKey;
        await writeJsonFile(file, contents);
      });
    },

    async retract(resourceUri: string): Promise<void> {
      const shard = shardFor(resourceUri);
      const file = paths.resourceIndexShardFile(shard);
      await withShardLock(shard, async () => {
        const contents = await readShard(file);
        if (!(resourceUri in contents)) {
          return;
        }
        delete contents[resourceUri];
        await writeJsonFile(file, contents);
      });
    },
  };
}
