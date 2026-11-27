import { FileViewSnapshotStore } from '@atolis-hq/eventing-filesystem';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const record = {
  viewName: 'work-index',
  schemaVersion: 2,
  position: 7,
  anchorEventId: 'e',
  value: { a: 1 },
};

it('round-trips a snapshot and leaves no temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-views-'));
  const store = new FileViewSnapshotStore(join(root, 'nested'));
  expect(await store.load('work-index')).toBeNull();

  await store.save(record);

  expect(await store.load('work-index')).toEqual(record);
  expect((await readdir(join(root, 'nested'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
});

it('treats unparseable or mismatched files as absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-views-'));
  const store = new FileViewSnapshotStore(root);
  await store.save(record);
  const [file] = await readdir(root);

  await writeFile(join(root, file!), '{not json');
  expect(await store.load('work-index')).toBeNull();

  await writeFile(join(root, file!), JSON.stringify({ ...record, viewName: 'other' }));
  expect(await store.load('work-index')).toBeNull();

  await writeFile(join(root, file!), JSON.stringify({ viewName: 'work-index' }));
  expect(await store.load('work-index')).toBeNull();
});
