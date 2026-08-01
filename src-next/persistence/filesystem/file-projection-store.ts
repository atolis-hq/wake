import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProjectionStore, StoredProjection } from '../../kernel/index.js';

export class FileProjectionStore implements ProjectionStore {
  constructor(private readonly root: string) {}
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

  async write<Value>(projection: StoredProjection<Value>): Promise<void> {
    await atomicJson(this.path(projection.namespace, projection.key), projection);
  }

  async list<Value>(namespace: string): Promise<readonly StoredProjection<Value>[]> {
    const directory = join(this.root, 'projections', encode(namespace));
    try {
      const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
      return Promise.all(
        files.map(
          async (file) =>
            JSON.parse(await readFile(join(directory, file), 'utf8')) as StoredProjection<Value>,
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async clear(namespace?: string): Promise<void> {
    await rm(
      namespace === undefined
        ? join(this.root, 'projections')
        : join(this.root, 'projections', encode(namespace)),
      { recursive: true, force: true },
    );
  }

  private path(namespace: string, key: string): string {
    return join(this.root, 'projections', encode(namespace), `${encode(key)}.json`);
  }
}

export function encode(value: string): string {
  if (value.length === 0 || /[\\/]/.test(value))
    throw new Error('Storage name must not contain path separators');
  return encodeURIComponent(value).replace(/\./g, '%2E');
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
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
