import type { ProjectionStore, StoredProjection } from '@atolis-hq/eventing';

import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { writeFileAtomically } from './atomic-write.js';
import { processorStateDirectoryNames } from './processor-state-paths.js';
import { encodeLegacyStorageName, encodeStorageName } from './storage-name.js';

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
    for (const path of projectionPaths(this.root, namespace, key).candidates) {
      const projection = await readProjection(path);
      if (matchesProjection(projection, namespace, key))
        return projection as StoredProjection<Value>;
    }
    return null;
  }

  // Patches the cached entry in place rather than invalidating the whole
  // namespace, so a self-caused write doesn't force the next list() to
  // re-read every other unchanged projection file in the namespace. Falls
  // back to a full list() re-read for a namespace nothing has cached yet.
  async write<Value>(projection: StoredProjection<Value>): Promise<void> {
    const paths = projectionPaths(this.root, projection.namespace, projection.key);
    const cached = this.listCache.get(projection.namespace);
    const path = paths.current;
    const existing =
      cached === undefined
        ? await readProjection(path)
        : (cached.files.find((entry) => entry.path === path)?.value ?? null);
    if (existing !== null && !matchesProjection(existing, projection.namespace, projection.key))
      throw new Error(`Projection path is occupied for ${projection.namespace}:${projection.key}`);
    await atomicJson(path, projection);
    if (cached === undefined) return;
    const [info, directoryInfo] = await Promise.all([stat(path), stat(dirname(path))]);
    const updatedEntry: CachedProjectionFile = {
      path,
      size: info.size,
      mtimeMs: info.mtimeMs,
      value: projection,
    };
    this.listCache.set(projection.namespace, {
      files: [
        ...cached.files.filter(
          (entry) =>
            entry.path !== path &&
            !matchesProjection(entry.value, projection.namespace, projection.key),
        ),
        updatedEntry,
      ].sort(compareCachedProjectionFiles),
      revisions: cached.revisions.map((revision) =>
        revision.directory === dirname(path)
          ? { ...revision, value: directoryRevision(directoryInfo) }
          : revision,
      ),
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
    const directories = projectionDirectories(this.root, namespace);
    const revisions = await directoryRevisions(directories);
    const cached = this.listCache.get(namespace);
    if (cached !== undefined && sameDirectoryRevisions(cached.revisions, revisions))
      return cached.files.map((entry) => entry.value) as StoredProjection<Value>[];
    const entries = await Promise.all(directories.map(readProjectionDirectory));
    const selected = new Map<string, CachedProjectionFile>();
    for (const entry of entries.flat()) {
      if (!matchesProjection(entry.value, namespace)) continue;
      if (!selected.has(entry.value.key)) selected.set(entry.value.key, entry);
    }
    const files = [...selected.values()].sort(compareCachedProjectionFiles);
    this.listCache.set(namespace, {
      files,
      revisions,
    });
    return files.map((entry) => entry.value) as StoredProjection<Value>[];
  }

  async clear(namespace?: string): Promise<void> {
    if (namespace === undefined) await this.clearAllProjectionDirectories();
    else
      await Promise.all(
        projectionDirectories(this.root, namespace).map(async (directory) => {
          if (this.protectedDirectories.has(directoryName(directory))) return;
          await clearProjectionDirectory(directory, namespace);
        }),
      );
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
}

interface CachedProjectionFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly value: StoredProjection<unknown>;
}

interface CachedProjectionDirectory {
  readonly files: readonly CachedProjectionFile[];
  readonly revisions: readonly DirectoryRevision[];
}

interface DirectoryRevision {
  readonly directory: string;
  readonly value: string | null;
}

interface ProjectionPaths {
  readonly current: string;
  readonly legacy: string;
  readonly candidates: readonly string[];
}

function directoryRevision(info: Awaited<ReturnType<typeof stat>>): string {
  return `${info.mtimeMs}:${info.ctimeMs}`;
}

function projectionPaths(root: string, namespace: string, key: string): ProjectionPaths {
  const currentNamespace = encode(namespace);
  const currentKey = encode(key);
  const legacyNamespace = encodeLegacyStorageName(namespace);
  const legacyKey = encodeLegacyStorageName(key);
  const current = projectionPath(
    root,
    `%projection-${currentNamespace}`,
    `%projection-${currentKey}`,
  );
  const legacy = projectionPath(root, legacyNamespace, legacyKey);
  return {
    current,
    legacy,
    candidates: uniquePaths([current, legacy]),
  };
}

function projectionDirectories(root: string, namespace: string): readonly string[] {
  const currentNamespace = encode(namespace);
  return uniquePaths([
    join(root, 'projections', `%projection-${currentNamespace}`),
    join(root, 'projections', encodeLegacyStorageName(namespace)),
  ]);
}

function projectionPath(root: string, namespace: string, key: string): string {
  return join(root, 'projections', namespace, `${key}.json`);
}

async function readProjection(path: string): Promise<StoredProjection | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as StoredProjection;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function matchesProjection(
  projection: StoredProjection | null,
  namespace: string,
  key?: string,
): projection is StoredProjection {
  return (
    projection !== null &&
    projection.namespace === namespace &&
    (key === undefined || projection.key === key)
  );
}

async function readProjectionDirectory(
  directory: string,
): Promise<readonly CachedProjectionFile[]> {
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(
    files.map(async (file): Promise<CachedProjectionFile> => {
      const path = join(directory, file);
      const [info, value] = await Promise.all([stat(path), readProjection(path)]);
      if (value === null) throw new Error(`Projection disappeared while listing: ${path}`);
      return { path, size: info.size, mtimeMs: info.mtimeMs, value };
    }),
  );
}

async function directoryRevisions(
  directories: readonly string[],
): Promise<readonly DirectoryRevision[]> {
  return Promise.all(
    directories.map(async (directory) => {
      try {
        return { directory, value: directoryRevision(await stat(directory)) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { directory, value: null };
        throw error;
      }
    }),
  );
}

function sameDirectoryRevisions(
  left: readonly DirectoryRevision[],
  right: readonly DirectoryRevision[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.directory === right[index]!.directory && entry.value === right[index]!.value,
    )
  );
}

function compareCachedProjectionFiles(
  left: CachedProjectionFile,
  right: CachedProjectionFile,
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

async function clearProjectionDirectory(directory: string, namespace: string): Promise<void> {
  const entries = await readProjectionDirectory(directory);
  await Promise.all(
    entries
      .filter((entry) => matchesProjection(entry.value, namespace))
      .map((entry) => rm(entry.path, { force: true })),
  );
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

function directoryName(path: string): string {
  return basename(path);
}

export function encode(value: string): string {
  return encodeStorageName(value);
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value)}\n`);
}
