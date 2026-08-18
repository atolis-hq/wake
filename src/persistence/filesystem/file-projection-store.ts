import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProjectionStore, StoredProjection } from '../../kernel/index.js';

export class FileProjectionStore implements ProjectionStore {
  constructor(private readonly root: string) {}

  private readonly listCache = new Map<string, readonly CachedProjectionFile[]>();

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
    const info = await stat(path);
    const file = `${encode(projection.key)}.json`;
    const updatedEntry: CachedProjectionFile = {
      file,
      size: info.size,
      mtimeMs: info.mtimeMs,
      value: projection,
    };
    this.listCache.set(
      projection.namespace,
      [...cached.filter((entry) => entry.file !== file), updatedEntry].sort((a, b) =>
        a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
      ),
    );
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
    const cached = this.listCache.get(namespace);
    if (cached !== undefined && sameProjectionFiles(cached, stats))
      return cached.map((entry) => entry.value) as StoredProjection<Value>[];
    const entries = await Promise.all(
      stats.map(async ({ file, size, mtimeMs }): Promise<CachedProjectionFile> => ({
        file,
        size,
        mtimeMs,
        value: JSON.parse(await readFile(join(directory, file), 'utf8')) as StoredProjection<Value>,
      })),
    );
    this.listCache.set(namespace, entries);
    return entries.map((entry) => entry.value) as StoredProjection<Value>[];
  }

  async clear(namespace?: string): Promise<void> {
    await rm(
      namespace === undefined
        ? join(this.root, 'projections')
        : join(this.root, 'projections', encode(namespace)),
      { recursive: true, force: true },
    );
    if (namespace === undefined) this.listCache.clear();
    else this.listCache.delete(namespace);
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
  if (value.length === 0 || /[\\/]/.test(value))
    throw new Error('Storage name must not contain path separators');
  return encodeURIComponent(value).replace(/%/g, '~').replace(/\./g, '~2E');
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
