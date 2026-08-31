import { FileProcessorStateStore } from '@atolis-hq/eventing-filesystem';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { encode } from '../src/file-projection-store.js';

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
  await expect(
    readFile(
      join(root, 'projections', encode(`${consumer}:pending`), `${encode(key)}.json`),
      'utf8',
    ),
  ).resolves.toBe(
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
    const path = join(root, 'projections', encode(`${consumer}:pending`), `${encode(key)}.json`);
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
  const path = join(root, 'projections', encode(`${consumer}:pending`), `${encode(key)}.json`);
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
    const path = join(
      root,
      'projections',
      encode(`${consumer}:pending`),
      `${encode(requestedKey)}.json`,
    );
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

it.each([
  ['the canonical and legacy delivery path', deliveryProcessorStatePath],
  ['the delivery fallback path', deliveryProcessorStateFallbackPath],
])('rejects a misplaced foreign record at %s without changing it', async (_case, candidatePath) => {
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
});

it('preflights every candidate before a corrupt fallback can hide a current processor state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-processor-state-'));
  const consumer = 'reactor:delivery-outcomes';
  const key = 'pending-confirmations';
  const store = new FileProcessorStateStore(root);
  await store.write({ consumer, key, value: { events: ['event-1'] } });
  const currentPath = deliveryProcessorStatePath(root);
  const currentRaw = await readFile(currentPath, 'utf8');
  const fallbackPath = deliveryProcessorStateFallbackPath(root);
  const corruptRaw = '{}\n';
  await mkdir(join(fallbackPath, '..'), { recursive: true });
  await writeFile(fallbackPath, corruptRaw);

  await expect(store.read(consumer, key)).rejects.toThrow('Invalid processor state record');
  await expect(store.write({ consumer, key, value: { events: ['event-2'] } })).rejects.toThrow(
    'Invalid processor state record',
  );
  await expect(store.delete(consumer, key)).rejects.toThrow('Invalid processor state record');

  await expect(readFile(currentPath, 'utf8')).resolves.toBe(currentRaw);
  await expect(readFile(fallbackPath, 'utf8')).resolves.toBe(corruptRaw);
});

it('deletes every matching processor state candidate after a clean preflight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-processor-state-'));
  const consumer = 'reactor:delivery-outcomes';
  const key = 'pending-confirmations';
  const store = new FileProcessorStateStore(root);
  await store.write({ consumer, key, value: { events: ['event-1'] } });
  const currentPath = deliveryProcessorStatePath(root);
  const fallbackPath = deliveryProcessorStateFallbackPath(root);
  const currentRaw = await readFile(currentPath, 'utf8');
  await mkdir(join(fallbackPath, '..'), { recursive: true });
  await writeFile(fallbackPath, currentRaw);

  await store.delete(consumer, key);

  await expect(readFile(currentPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(fallbackPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

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

it('keeps consumers whose old projection encodings collide isolated', async () => {
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

it('keeps keys whose old projection encodings collide isolated', async () => {
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

it('allows colliding legacy names to write concurrently without cross-over', async () => {
  const store = new FileProcessorStateStore(await mkdtemp(join(tmpdir(), 'wake-processor-state-')));
  const key = 'pending-confirmations';

  await Promise.all([
    store.write({ consumer: 'a.b', key, value: { owner: 'dot' } }),
    store.write({ consumer: 'a~2Eb', key, value: { owner: 'tilde' } }),
  ]);

  await expect(store.read('a.b', key)).resolves.toMatchObject({ value: { owner: 'dot' } });
  await expect(store.read('a~2Eb', key)).resolves.toMatchObject({ value: { owner: 'tilde' } });
});

it('preserves a true legacy collision only for its persisted identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-processor-state-'));
  const store = new FileProcessorStateStore(root);
  const key = 'pending-confirmations';
  const legacyConsumer = 'a~2Eb';
  const legacyNamespace = `${legacyConsumer}:pending`;
  const legacyPath = join(root, 'projections', encode(legacyNamespace), `${encode(key)}.json`);
  expect(legacyPath).toBe(join(root, 'projections', encode('a.b:pending'), `${encode(key)}.json`));
  await mkdir(join(legacyPath, '..'), { recursive: true });
  await writeFile(
    legacyPath,
    `${JSON.stringify({
      namespace: legacyNamespace,
      key,
      lastGlobalPosition: 0,
      value: { owner: 'legacy-tilde' },
    })}\n`,
  );

  await expect(store.read('a.b', key)).resolves.toBeNull();
  await expect(store.read(legacyConsumer, key)).resolves.toMatchObject({
    value: { owner: 'legacy-tilde' },
  });

  await store.write({ consumer: 'a.b', key, value: { owner: 'dot' } });
  await store.delete('a.b', key);

  await expect(readFile(legacyPath, 'utf8')).resolves.toContain('legacy-tilde');
  await expect(store.read(legacyConsumer, key)).resolves.toMatchObject({
    value: { owner: 'legacy-tilde' },
  });
});

function deliveryProcessorStatePath(root: string): string {
  return join(
    root,
    'projections',
    encode('reactor:delivery-outcomes:pending'),
    `${encode('pending-confirmations')}.json`,
  );
}

function deliveryProcessorStateFallbackPath(root: string): string {
  return join(
    root,
    'projections',
    '%processor-state-reactor~3Adelivery-outcomes~3Apending',
    '%processor-state-pending-confirmations.json',
  );
}
