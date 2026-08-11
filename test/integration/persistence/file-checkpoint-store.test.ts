import { mkdtemp } from 'node:fs/promises';
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
