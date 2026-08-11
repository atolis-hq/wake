import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { wakeVersion } from '../../../src/bootstrap/version.js';

const binDirectory = resolve(process.cwd(), 'bin');
const launcherPath = resolve(binDirectory, 'wake-dev.js');
const binPackage = JSON.parse(readFileSync(resolve(binDirectory, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
};

describe('target development launcher', () => {
  it('registers the public wake-dev command to the target launcher', () => {
    expect(binPackage.bin['wake-dev']).toBe('./wake-dev.js');
  });

  it('forwards --version to src/main.ts', { timeout: 15_000 }, () => {
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
      const command = 'not-a-command & echo wake-dev-shell-injection';
      const result = spawnSync(process.execPath, [launcherPath, command], {
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Unknown wake command: ${command}`);
      expect(result.stdout).not.toContain('wake-dev-shell-injection');
      expect(result.stderr).not.toContain('wake-dev-shell-injection\n');
    },
  );

  describe('when it is installed without a sibling src/main.ts', () => {
    let temporaryDirectory: string | undefined;

    afterEach(async () => {
      if (temporaryDirectory !== undefined) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        temporaryDirectory = undefined;
      }
    });

    it('explains that wake-dev requires a source checkout', async () => {
      temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'wake-dev-packaged-'));
      await mkdir(join(temporaryDirectory, 'bin'), { recursive: true });
      await copyFile(launcherPath, join(temporaryDirectory, 'bin', 'wake-dev.mjs'));

      const result = spawnSync(
        process.execPath,
        [join(temporaryDirectory, 'bin', 'wake-dev.mjs'), '--version'],
        { encoding: 'utf8' },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('source checkout');
    });
  });
});
