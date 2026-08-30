import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createFileProcessorRunSerialiser } from '../../../src/persistence/index.js';

it('serialises equal file-backed processor consumers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-processor-serialiser-'));
  try {
    const serialise = createFileProcessorRunSerialiser(root);
    let active = 0;
    let maximum = 0;
    await Promise.all(
      [1, 2].map(() =>
        serialise('processor:one', new AbortController().signal, async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await Promise.resolve();
          active -= 1;
        }),
      ),
    );
    expect(maximum).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
