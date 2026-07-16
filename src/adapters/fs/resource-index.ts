import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { acquireFileLock } from '../../lib/lock.js';
import { readJsonFile, writeJsonFile } from '../../lib/json-file.js';
import type { WakePaths } from '../../lib/paths.js';

export interface ResourceIndex {
  resolve(resourceUri: string): Promise<string | undefined>;
  register(resourceUri: string, workItemKey: string): Promise<void>;
  retract(resourceUri: string): Promise<void>;
  replaceAll(entries: ReadonlyMap<string, string>): Promise<void>;
}

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

export function createResourceIndex({ paths }: { paths: WakePaths }): ResourceIndex {
  async function withShardLock<T>(shard: string, fn: () => Promise<T>): Promise<T> {
    const lock = await acquireFileLock(`${paths.resourceIndexShardFile(shard)}.lock`, {
      staleAfterMs: 60_000,
    });
    try {
      return await fn();
    } finally {
      await lock.release();
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

    async replaceAll(entries: ReadonlyMap<string, string>): Promise<void> {
      await rm(paths.resourceIndexRoot, { recursive: true, force: true });

      const byShard = new Map<string, ShardContents>();
      for (const [resourceUri, workItemKey] of entries) {
        const shard = shardFor(resourceUri);
        const contents = byShard.get(shard) ?? {};
        contents[resourceUri] = workItemKey;
        byShard.set(shard, contents);
      }

      for (const [shard, contents] of byShard) {
        await writeJsonFile(paths.resourceIndexShardFile(shard), contents);
      }
    },
  };
}
