import type { ProjectionStore, StoredProjection } from '@atolis-hq/eventing';

import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomically } from './atomic-write.js';
import { processorStateDirectoryNames } from './processor-state-paths.js';
import { encodeStorageName } from './storage-name.js';

export interface FileProjectionStoreOptions {
  readonly protectedProcessorStateConsumers?: readonly string[];
}

export class FileProjectionStore implements ProjectionStore {
  private readonly protectedDirectories: ReadonlySet<string>;

  constructor(
    private readonly root: string,
    options: FileProjectionStoreOptions = {},
  ) {
    this.protectedDirectories = new Set(
      (options.protectedProcessorStateConsumers ?? []).flatMap(processorStateDirectoryNames),
    );
  }

  private readonly listCache = new Map<string, CachedProjectionDirectory>();

  async read<Value>(namespace: string, key: string): Promise<StoredProjection<Value> | null> {
    try {
      return JSON.parse(
        await readFile(this.path(namespace, key), 'utf8'),
      ) as StoredProjection<Value>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  // Patches the cached entry in place rather than invalidating the whole
  // namespace, so a self-caused write doesn't force the next list() to
  // re-read every other unchanged projection file in the namespace. Falls
  // back to a full list() re-read for a namespace nothing has cached yet.
  async write<Value>(projection: StoredProjection<Value>): Promise<void> {
    const path = this.path(projection.namespace, projection.key);
    await atomicJson(path, projection);
    const cached = this.listCache.get(projection.namespace);
    if (cached === undefined) return;
    const [info, directoryInfo] = await Promise.all([stat(path), stat(dirname(path))]);
    const file = `${encode(projection.key)}.json`;
    const updatedEntry: CachedProjectionFile = {
      file,
      size: info.size,
      mtimeMs: info.mtimeMs,
      value: projection,
    };
    this.listCache.set(projection.namespace, {
      files: [...cached.files.filter((entry) => entry.file !== file), updatedEntry].sort((a, b) =>
        a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
      ),
      revision: directoryRevision(directoryInfo),
    });
  }

  // Callers (advance-once, orchestration-service, DeliveryService, ...) list()
  // an entire namespace unconditionally on every control-plane tick, even when
  // fully idle. Without a cache that's a readdir+open+read+JSON.parse of every
  // projection file in the namespace every tick forever, mirroring the same
  // cost FileEventJournal.scan() already avoids for the event journal via a
  // fingerprint cache. Same fix here: only re-read files whose directory
  // listing (name:size:mtimeMs) actually changed since the last list().
  async list<Value>(namespace: string): Promise<readonly StoredProjection<Value>[]> {
    const directory = join(this.root, 'projections', encode(namespace));
    let directoryInfo: Awaited<ReturnType<typeof stat>>;
    try {
      directoryInfo = await stat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.listCache.delete(namespace);
        return [];
      }
      throw error;
    }
    const cached = this.listCache.get(namespace);
    if (cached !== undefined && cached.revision === directoryRevision(directoryInfo))
      return cached.files.map((entry) => entry.value) as StoredProjection<Value>[];
    let files: string[];
    try {
      files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.listCache.delete(namespace);
        return [];
      }
      throw error;
    }
    const stats = await Promise.all(
      files.map(async (file) => {
        const info = await stat(join(directory, file));
        return { file, size: info.size, mtimeMs: info.mtimeMs };
      }),
    );
    if (cached !== undefined && sameProjectionFiles(cached.files, stats))
      return cached.files.map((entry) => entry.value) as StoredProjection<Value>[];
    const entries = await Promise.all(
      stats.map(async ({ file, size, mtimeMs }): Promise<CachedProjectionFile> => ({
        file,
        size,
        mtimeMs,
        value: JSON.parse(await readFile(join(directory, file), 'utf8')) as StoredProjection<Value>,
      })),
    );
    this.listCache.set(namespace, { files: entries, revision: directoryRevision(directoryInfo) });
    return entries.map((entry) => entry.value) as StoredProjection<Value>[];
  }

  async clear(namespace?: string): Promise<void> {
    if (namespace === undefined) await this.clearAllProjectionDirectories();
    else if (!this.protectedDirectories.has(encode(namespace)))
      await rm(join(this.root, 'projections', encode(namespace)), { recursive: true, force: true });
    if (namespace === undefined) this.listCache.clear();
    else this.listCache.delete(namespace);
  }

  private async clearAllProjectionDirectories(): Promise<void> {
    const root = join(this.root, 'projections');
    let namespaces: string[];
    try {
      namespaces = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      namespaces.map(async (namespace) => {
        const directory = join(root, namespace);
        if (this.protectedDirectories.has(namespace)) return;
        await rm(directory, { recursive: true, force: true });
      }),
    );
  }

  private path(namespace: string, key: string): string {
    return join(this.root, 'projections', encode(namespace), `${encode(key)}.json`);
  }
}

interface CachedProjectionFile {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly value: StoredProjection<unknown>;
}

interface CachedProjectionDirectory {
  readonly files: readonly CachedProjectionFile[];
  readonly revision: string;
}

function directoryRevision(info: Awaited<ReturnType<typeof stat>>): string {
  return `${info.mtimeMs}:${info.ctimeMs}`;
}

function sameProjectionFiles(
  cached: readonly CachedProjectionFile[],
  stats: readonly { readonly file: string; readonly size: number; readonly mtimeMs: number }[],
): boolean {
  return (
    cached.length === stats.length &&
    cached.every((entry, index) => {
      const other = stats[index]!;
      return (
        entry.file === other.file && entry.size === other.size && entry.mtimeMs === other.mtimeMs
      );
    })
  );
}

export function encode(value: string): string {
  return encodeStorageName(value);
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value)}\n`);
}
