import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { wakeVersion } from '../../../src-next/bootstrap/version.js';

const launcherPath = resolve(process.cwd(), 'bin', 'wake-dev-next.js');

describe('target development launcher', () => {
  it('forwards --version to src-next/main.ts', { timeout: 15_000 }, () => {
    const result = spawnSync(process.execPath, [launcherPath, '--version'], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${wakeVersion}\n`);
  });

  it('forwards target command failures', { timeout: 15_000 }, () => {
    const result = spawnSync(process.execPath, [launcherPath, 'not-a-command'], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown wake command: not-a-command');
  });

  it(
    'treats shell metacharacters in an argument as literal command text',
    { timeout: 15_000 },
    () => {
      const command = 'not-a-command & echo wake-dev-next-shell-injection';
      const result = spawnSync(process.execPath, [launcherPath, command], {
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Unknown wake command: ${command}`);
      expect(result.stdout).not.toContain('wake-dev-next-shell-injection');
      expect(result.stderr).not.toContain('wake-dev-next-shell-injection\n');
    },
  );

  describe('when it is installed without a sibling src-next/main.ts', () => {
    let temporaryDirectory: string | undefined;

    afterEach(async () => {
      if (temporaryDirectory !== undefined) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        temporaryDirectory = undefined;
      }
    });

    it('explains that wake-dev-next requires a source checkout', async () => {
      temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'wake-dev-next-packaged-'));
      await mkdir(join(temporaryDirectory, 'bin'), { recursive: true });
      await copyFile(launcherPath, join(temporaryDirectory, 'bin', 'wake-dev-next.mjs'));

      const result = spawnSync(
        process.execPath,
        [join(temporaryDirectory, 'bin', 'wake-dev-next.mjs'), '--version'],
        { encoding: 'utf8' },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('source checkout');
    });
  });
});
