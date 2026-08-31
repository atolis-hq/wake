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

it('reads and deletes a legacy record only for its persisted identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-processor-state-'));
  const store = new FileProcessorStateStore(root);
  const key = 'pending-confirmations';
  const legacyConsumer = 'a~2Eb';
  const legacyNamespace = `${legacyConsumer}:pending`;
  const legacyPath = join(root, 'projections', encode(legacyNamespace), `${encode(key)}.json`);
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
