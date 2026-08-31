import { FileProcessorStateStore } from '@atolis-hq/eventing-filesystem';
import { mkdtemp, readFile } from 'node:fs/promises';
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
