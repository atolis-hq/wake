import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { assertTypeScriptFixtureCompiles } from './support/typescript-fixture.js';

it('reports strict TypeScript diagnostics before architecture assertions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-invalid-typescript-fixture-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'src', 'invalid.ts'),
      'const value: string = undefined;\nexport { value };\n',
      'utf8',
    );

    await expect(assertTypeScriptFixtureCompiles(root)).rejects.toThrow(
      /invalid\.ts:1:7 TS2322: Type 'undefined' is not assignable to type 'string'/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
