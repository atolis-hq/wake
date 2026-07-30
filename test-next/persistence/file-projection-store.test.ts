import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileProjectionStore } from '../../src-next/persistence/index.js';
it('stores and atomically replaces one projection without touching another namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-projections-'));
  const store = new FileProjectionStore(root);
  await store.write({ namespace: 'work', key: 'work:1', lastGlobalPosition: 1, value: { n: 1 } });
  await store.write({ namespace: 'other', key: 'work:1', lastGlobalPosition: 1, value: { n: 9 } });
  await store.write({ namespace: 'work', key: 'work:1', lastGlobalPosition: 2, value: { n: 2 } });
  expect(await store.read('work', 'work:1')).toMatchObject({
    lastGlobalPosition: 2,
    value: { n: 2 },
  });
  await store.clear('work');
  expect(await store.read('work', 'work:1')).toBeNull();
  expect(await store.read('other', 'work:1')).not.toBeNull();
});
