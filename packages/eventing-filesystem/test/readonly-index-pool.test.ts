import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { borrowReadonlyIndex, invalidateReadonlyIndex } from '../src/readonly-index-pool.js';

it('bounds retained connections and invalidates replaced database identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-index-pool-'));
  const databases: DatabaseSync[] = [];
  const paths: string[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const path = join(root, `${index}.sqlite`);
      paths.push(path);
      const created = new DatabaseSync(path);
      created.close();
      const lease = borrowReadonlyIndex(
        path,
        String(index),
        () => new DatabaseSync(path, { readOnly: true }),
      );
      databases.push(lease.database);
      lease.release();
    }
    expect(databases.filter((database) => database.isOpen).length).toBeLessThanOrEqual(4);
    const path = paths.at(-1)!;
    const previous = databases.at(-1)!;
    const replaced = borrowReadonlyIndex(
      path,
      'replacement',
      () => new DatabaseSync(path, { readOnly: true }),
    );
    expect(previous.isOpen).toBe(false);
    expect(replaced.database === previous).toBe(false);
    replaced.invalidate();
    expect(replaced.database.isOpen).toBe(false);
  } finally {
    paths.forEach(invalidateReadonlyIndex);
    await rm(root, { recursive: true, force: true });
  }
});
