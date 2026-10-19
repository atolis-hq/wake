import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Before the delegation gate batched its Work reads, each instance forced its
// own listing of every segment file and a tick exhausted a multi-GB heap.
// A 192 MB heap makes that regression fail fast; the fixed path needs a few MB.
it('gates hundreds of delegated instances over thousands of segments within a small heap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-stress-gate-'));
  const { stdout } = await run(
    process.execPath,
    [
      '--max-old-space-size=192',
      '--import',
      'tsx',
      join(repositoryRoot, 'test', 'stress', 'support', 'delegation-gate-fanout.ts'),
      root,
      '4000',
      '700',
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(repositoryRoot, 'tsconfig.source.json') },
      maxBuffer: 1 << 20,
    },
  );
  expect(stdout.trim()).toBe('ok');
});
