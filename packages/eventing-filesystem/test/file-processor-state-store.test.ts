import { FileProcessorStateStore } from '@atolis-hq/eventing-filesystem';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { processorStatePaths } from '../src/processor-state-paths.js';

it('atomically round-trips and deletes processor state at its compatible projection path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-processor-state-'));
  const store = new FileProcessorStateStore(root);
  const consumer = 'reactor:delivery-outcomes';
  const key = 'pending-confirmations';

  await store.write({ consumer, key, value: { events: ['event-1'] } });

  await expect(store.read(consumer, key)).resolves.toEqual({
    consumer,
    key,
    value: { events: ['event-1'] },
  });
  await expect(readFile(processorStatePaths(root, consumer, key).current, 'utf8')).resolves.toBe(
    `${JSON.stringify({
      namespace: `${consumer}:pending`,
      key,
      lastGlobalPosition: 0,
      value: { events: ['event-1'] },
    })}\n`,
  );

  await store.delete(consumer, key);

  await expect(store.read(consumer, key)).resolves.toBeNull();
});

it.each([
  ['consumer', '', 'pending-confirmations'],
  ['consumer', 'reactor/delivery-outcomes', 'pending-confirmations'],
  ['key', 'reactor:delivery-outcomes', ''],
  ['key', 'reactor:delivery-outcomes', 'pending/confirmations'],
])('rejects an invalid %s storage name', async (_part, consumer, key) => {
  const store = new FileProcessorStateStore(await mkdtemp(join(tmpdir(), 'wake-processor-state-')));

  await expect(store.write({ consumer, key, value: {} })).rejects.toThrow(
    'Storage name must not contain path separators',
  );
});

it.each([
  ['an array', []],
  ['an empty object', {}],
  ['a missing namespace', { key: 'pending-confirmations', lastGlobalPosition: 0, value: {} }],
  [
    'a non-string namespace',
    { namespace: 1, key: 'pending-confirmations', lastGlobalPosition: 0, value: {} },
  ],
  [
    'a non-string key',
    { namespace: 'reactor:delivery-outcomes:pending', key: 1, lastGlobalPosition: 0, value: {} },
  ],
  [
    'a nonzero last global position',
    {
      namespace: 'reactor:delivery-outcomes:pending',
      key: 'pending-confirmations',
      lastGlobalPosition: 1,
      value: {},
    },
  ],
  [
    'a non-number last global position',
    {
      namespace: 'reactor:delivery-outcomes:pending',
      key: 'pending-confirmations',
      lastGlobalPosition: '0',
      value: {},
    },
  ],
  [
    'a missing value',
    {
      namespace: 'reactor:delivery-outcomes:pending',
      key: 'pending-confirmations',
      lastGlobalPosition: 0,
    },
  ],
])(
  'rejects corrupt canonical processor state with %s without changing its file',
  async (_case, record) => {
    const root = await mkdtemp(join(tmpdir(), 'wake-processor-state-'));
    const consumer = 'reactor:delivery-outcomes';
    const key = 'pending-confirmations';
    const path = processorStatePaths(root, consumer, key).current;
    const raw = `${JSON.stringify(record)}\n`;
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, raw);
    const store = new FileProcessorStateStore(root);

    await expect(store.read(consumer, key)).rejects.toThrow('Invalid processor state record');

    await expect(readFile(path, 'utf8')).resolves.toBe(raw);
  },
);

it('does not overwrite or delete corrupt canonical processor state while considering collision fallbacks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-processor-state-'));
  const consumer = 'reactor:delivery-outcomes';
  const key = 'pending-confirmations';
  const path = processorStatePaths(root, consumer, key).current;
  const raw = '{}\n';
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, raw);
  const store = new FileProcessorStateStore(root);

  await expect(store.write({ consumer, key, value: { events: [] } })).rejects.toThrow(
    'Invalid processor state record',
  );
  await expect(readFile(path, 'utf8')).resolves.toBe(raw);

  await expect(store.delete(consumer, key)).rejects.toThrow('Invalid processor state record');
  await expect(readFile(path, 'utf8')).resolves.toBe(raw);
});

it.each([
  ['an empty namespace', '', 'pending-confirmations'],
  ['a namespace without the pending suffix', 'reactor:delivery-outcomes', 'pending-confirmations'],
  [
    'a namespace with a path separator',
    'reactor/delivery-outcomes:pending',
    'pending-confirmations',
  ],
  ['an ill-formed namespace', '\uD800:pending', 'pending-confirmations'],
  ['an empty key', 'reactor:delivery-outcomes:pending', ''],
  ['a key with a path separator', 'reactor:delivery-outcomes:pending', 'pending/confirmations'],
  ['an ill-formed key', 'reactor:delivery-outcomes:pending', '\uD800'],
])(
  'rejects an invalid persisted processor state identity with %s without changing its file',
  async (_case, namespace, key) => {
    const root = await mkdtemp(join(tmpdir(), 'wake-processor-state-'));
    const consumer = 'reactor:delivery-outcomes';
    const requestedKey = 'pending-confirmations';
    const path = processorStatePaths(root, consumer, requestedKey).current;
    const raw = `${JSON.stringify({ namespace, key, lastGlobalPosition: 0, value: { events: [] } })}\n`;
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, raw);
    const store = new FileProcessorStateStore(root);

    await expect(store.read(consumer, requestedKey)).rejects.toThrow(
      'Invalid processor state record',
    );
    await expect(readFile(path, 'utf8')).resolves.toBe(raw);

    await expect(
      store.write({ consumer, key: requestedKey, value: { events: [] } }),
    ).rejects.toThrow('Invalid processor state record');
    await expect(readFile(path, 'utf8')).resolves.toBe(raw);

    await expect(store.delete(consumer, requestedKey)).rejects.toThrow(
      'Invalid processor state record',
    );
    await expect(readFile(path, 'utf8')).resolves.toBe(raw);
  },
);

it.each([['the canonical delivery path', deliveryProcessorStatePath]])(
  'rejects a misplaced foreign record at %s without changing it',
  async (_case, candidatePath) => {
    const root = await mkdtemp(join(tmpdir(), 'wake-processor-state-'));
    const consumer = 'reactor:delivery-outcomes';
    const key = 'pending-confirmations';
    const path = candidatePath(root);
    const raw = `${JSON.stringify({
      namespace: 'other:pending',
      key: 'other-key',
      lastGlobalPosition: 0,
      value: { events: [] },
    })}\n`;
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, raw);
    const store = new FileProcessorStateStore(root);

    await expect(store.read(consumer, key)).rejects.toThrow('Invalid processor state record');
    await expect(readFile(path, 'utf8')).resolves.toBe(raw);

    await expect(store.write({ consumer, key, value: { events: [] } })).rejects.toThrow(
      'Invalid processor state record',
    );
    await expect(readFile(path, 'utf8')).resolves.toBe(raw);

    await expect(store.delete(consumer, key)).rejects.toThrow('Invalid processor state record');
    await expect(readFile(path, 'utf8')).resolves.toBe(raw);
  },
);

it('serializes processor state under a long data root', async () => {
  const root = await mkdtemp(join(tmpdir(), `wake-processor-state-${'long-root-'.repeat(12)}`));
  const store = new FileProcessorStateStore(root);

  await store.write({
    consumer: 'reactor:delivery-outcomes',
    key: 'pending-confirmations',
    value: { events: ['event-1'] },
  });

  await expect(store.read('reactor:delivery-outcomes', 'pending-confirmations')).resolves.toEqual({
    consumer: 'reactor:delivery-outcomes',
    key: 'pending-confirmations',
    value: { events: ['event-1'] },
  });
});

it('stores a long processor-state key in a bounded path component', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-processor-state-'));
  const consumer = 'reactor:delivery-outcomes';
  const key = `pending:${'key-'.repeat(1_000)}`;
  const store = new FileProcessorStateStore(root);

  await store.write({ consumer, key, value: { events: [] } });

  const path = processorStatePaths(root, consumer, key).current;
  expect(path.split('/').at(-1)).toHaveLength(48);
  expect(path.split('/').at(-2)).toHaveLength(43);
  await expect(store.read(consumer, key)).resolves.toMatchObject({ value: { events: [] } });
});

it('keeps consumers with distinct source names isolated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-processor-state-'));
  const store = new FileProcessorStateStore(root);
  const key = 'pending-confirmations';

  await store.write({ consumer: 'a.b', key, value: { owner: 'dot' } });
  await store.write({ consumer: 'a~2Eb', key, value: { owner: 'tilde' } });

  await expect(store.read('a.b', key)).resolves.toMatchObject({ value: { owner: 'dot' } });
  await expect(store.read('a~2Eb', key)).resolves.toMatchObject({ value: { owner: 'tilde' } });

  await store.delete('a~2Eb', key);

  await expect(store.read('a.b', key)).resolves.toMatchObject({ value: { owner: 'dot' } });
  await expect(store.read('a~2Eb', key)).resolves.toBeNull();
});

it('keeps keys with distinct source names isolated', async () => {
  const store = new FileProcessorStateStore(await mkdtemp(join(tmpdir(), 'wake-processor-state-')));
  const consumer = 'reactor:delivery-outcomes';

  await store.write({ consumer, key: 'a.b', value: { owner: 'dot' } });
  await store.write({ consumer, key: 'a~2Eb', value: { owner: 'tilde' } });

  await expect(store.read(consumer, 'a.b')).resolves.toMatchObject({ value: { owner: 'dot' } });
  await expect(store.read(consumer, 'a~2Eb')).resolves.toMatchObject({ value: { owner: 'tilde' } });

  await store.delete(consumer, 'a~2Eb');

  await expect(store.read(consumer, 'a.b')).resolves.toMatchObject({ value: { owner: 'dot' } });
  await expect(store.read(consumer, 'a~2Eb')).resolves.toBeNull();
});

it('allows distinct names to write concurrently without cross-over', async () => {
  const store = new FileProcessorStateStore(await mkdtemp(join(tmpdir(), 'wake-processor-state-')));
  const key = 'pending-confirmations';

  await Promise.all([
    store.write({ consumer: 'a.b', key, value: { owner: 'dot' } }),
    store.write({ consumer: 'a~2Eb', key, value: { owner: 'tilde' } }),
  ]);

  await expect(store.read('a.b', key)).resolves.toMatchObject({ value: { owner: 'dot' } });
  await expect(store.read('a~2Eb', key)).resolves.toMatchObject({ value: { owner: 'tilde' } });
  // The adapter permits five seconds of filesystem lock contention.
}, 15_000);

function deliveryProcessorStatePath(root: string): string {
  return processorStatePaths(root, 'reactor:delivery-outcomes', 'pending-confirmations').current;
}
