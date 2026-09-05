import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { isMainEntrypoint } from '../../src/main.js';

describe('Wake CLI entrypoint guard', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it('recognizes a symlinked invocation of the real entrypoint', async () => {
    directory = await mkdtemp(join(tmpdir(), 'wake-cli-entrypoint-'));
    const entrypoint = join(directory, 'main.js');
    const invocation = join(directory, 'wake');
    await writeFile(entrypoint, '');
    await symlink(entrypoint, invocation);

    expect(isMainEntrypoint(pathToFileURL(entrypoint).href, invocation)).toBe(true);
  });

  it('does not run when the process has no script argument', () => {
    expect(isMainEntrypoint(import.meta.url, undefined)).toBe(false);
  });
});
