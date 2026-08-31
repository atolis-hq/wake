import { FileProjectionStore } from '@atolis-hq/eventing-filesystem';
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const { readFileMock, statMock } = vi.hoisted(() => ({ readFileMock: vi.fn(), statMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  readFileMock.mockImplementation(actual.readFile);
  statMock.mockImplementation(actual.stat);
  return { ...actual, readFile: readFileMock, stat: statMock };
});

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

it('uses distinct temporary files for concurrent writes to one projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-projections-'));
  const store = new FileProjectionStore(root);

  await expect(
    Promise.all([
      store.write({ namespace: 'work', key: 'work:1', lastGlobalPosition: 1, value: { n: 1 } }),
      store.write({ namespace: 'work', key: 'work:1', lastGlobalPosition: 2, value: { n: 2 } }),
    ]),
  ).resolves.toEqual([undefined, undefined]);

  expect(await store.read('work', 'work:1')).not.toBeNull();
});

it('does not re-read namespace files on a second list() when nothing changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-projections-cache-'));
  const store = new FileProjectionStore(root);
  await store.write({ namespace: 'work', key: 'work:1', lastGlobalPosition: 1, value: { n: 1 } });
  await store.write({ namespace: 'work', key: 'work:2', lastGlobalPosition: 1, value: { n: 2 } });

  readFileMock.mockClear();
  statMock.mockClear();
  await store.list('work');
  const firstCallCount = readFileMock.mock.calls.length;
  const firstStatCallCount = statMock.mock.calls.length;
  expect(firstCallCount).toBeGreaterThan(0);
  expect(firstStatCallCount).toBeGreaterThan(0);

  const second = await store.list('work');
  expect(readFileMock.mock.calls.length).toBe(firstCallCount);
  // Only the namespace directory is probed for an external atomic write;
  // the two projection files themselves are not restatted.
  expect(statMock.mock.calls.length).toBe(firstStatCallCount + 1);
  expect(second).toHaveLength(2);

  // A write patches the cache with the in-memory value being written, so the
  // following list() needs no readFile calls at all — not even for the new
  // key — rather than re-reading the whole namespace from disk.
  await store.write({ namespace: 'work', key: 'work:3', lastGlobalPosition: 1, value: { n: 3 } });
  const third = await store.list('work');
  expect(readFileMock.mock.calls.length).toBe(firstCallCount);
  expect(third).toHaveLength(3);
});

it('refreshes a cached namespace after another store atomically writes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-projections-external-write-'));
  const reader = new FileProjectionStore(root);
  const writer = new FileProjectionStore(root);
  await writer.write({ namespace: 'work', key: 'work:1', lastGlobalPosition: 1, value: { n: 1 } });

  expect(await reader.list('work')).toHaveLength(1);
  await writer.write({ namespace: 'work', key: 'work:2', lastGlobalPosition: 2, value: { n: 2 } });

  expect(await reader.list('work')).toMatchObject([
    { key: 'work:1', value: { n: 1 } },
    { key: 'work:2', value: { n: 2 } },
  ]);
});
