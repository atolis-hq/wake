import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const binPath = resolve(process.cwd(), 'bin', 'wake-dev.js');

describe('bin/wake-dev.js', () => {
  it('runs src/main.ts live and forwards the exit code', { timeout: 15_000 }, () => {
    const result = spawnSync(process.execPath, [binPath, '--version'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  describe('when there is no sibling src/main.ts (packaged install)', () => {
    let tempDir: string | undefined;

    afterEach(async () => {
      if (tempDir !== undefined) {
        await rm(tempDir, { recursive: true, force: true });
        tempDir = undefined;
      }
    });

    it('prints a clear error and exits non-zero instead of trying to spawn tsx', async () => {
      tempDir = await mkdtemp(resolve(tmpdir(), 'wake-dev-packaged-'));
      await mkdir(join(tempDir, 'bin'), { recursive: true });
      // .mjs so Node treats it as ESM without needing a package.json
      // ancestor declaring "type": "module" in this bare temp dir.
      await copyFile(binPath, join(tempDir, 'bin', 'wake-dev.mjs'));
      // deliberately no src/main.ts next to it

      const result = spawnSync(
        process.execPath,
        [join(tempDir, 'bin', 'wake-dev.mjs'), '--version'],
        {
          encoding: 'utf8',
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('packaged install');
    });
  });
});
