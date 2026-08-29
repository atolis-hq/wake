import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileCheckpointStore } from '../../../src/persistence/index.js';

it('loads, advances, resets, and rejects checkpoint regression', async () => {
  const store = new FileCheckpointStore(await mkdtemp(join(tmpdir(), 'wake-checkpoints-')));
  expect(await store.load('projection:work')).toBe(0);
  await store.save('projection:work', 4);
  expect(await store.load('projection:work')).toBe(4);
  await expect(store.save('projection:work', 3)).rejects.toThrow(/regression/);
  await store.reset('projection:work');
  expect(await store.load('projection:work')).toBe(0);
});

it('serializes concurrent saves for one consumer so checkpoints cannot regress', async () => {
  const store = new FileCheckpointStore(await mkdtemp(join(tmpdir(), 'wake-checkpoints-')));

  const results = await Promise.allSettled([
    store.save('projection:work', 8),
    store.save('projection:work', 7),
  ]);

  expect(results[0]).toMatchObject({ status: 'fulfilled' });
  expect(results[1]).toMatchObject({ status: 'rejected' });
  expect(await store.load('projection:work')).toBe(8);
});

it('keeps consumers whose legacy encodings collide in distinct checkpoint files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-checkpoints-'));
  const store = new FileCheckpointStore(root);

  await store.save('a.b', 3);
  await store.save('a~2Eb', 7);

  expect(await store.load('a.b')).toBe(3);
  expect(await store.load('a~2Eb')).toBe(7);
});

it('reads a legacy checkpoint and writes subsequent progress to its v2 path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-checkpoints-'));
  const checkpointDirectory = join(root, 'checkpoints');
  await mkdir(checkpointDirectory, { recursive: true });
  await writeFile(
    join(checkpointDirectory, 'legacy~3Aconsumer.json'),
    `${JSON.stringify({ consumer: 'legacy:consumer', globalPosition: 4 })}\n`,
  );
  const store = new FileCheckpointStore(root);

  expect(await store.load('legacy:consumer')).toBe(4);
  await store.save('legacy:consumer', 5);

  expect(await store.load('legacy:consumer')).toBe(5);
  await expect(
    readFile(join(checkpointDirectory, 'v2-bGVnYWN5OmNvbnN1bWVy.json'), 'utf8'),
  ).resolves.toContain('"globalPosition":5');
});
