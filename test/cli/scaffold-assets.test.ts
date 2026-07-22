import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scaffoldWakeHome } from '../../src/cli/scaffold-assets.js';

describe('scaffoldWakeHome launchers', () => {
  it('routes stop to the host in the bash and PowerShell launchers', async () => {
    const wakeRoot = await mkdtemp(resolve(tmpdir(), 'wake-scaffold-'));
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const shellLauncher = await readFile(resolve(wakeRoot, 'wake.sh'), 'utf8');
    const powerShellLauncher = await readFile(resolve(wakeRoot, 'wake.ps1'), 'utf8');

    expect(shellLauncher).toContain('init|sandbox|stop)');
    expect(powerShellLauncher).toContain('"stop" {');
  });
});

describe('scaffoldWakeHome config.json', () => {
  it('derives sandbox.containerName from the wake-root directory name', async () => {
    const tempBase = await mkdtemp(resolve(tmpdir(), 'wake-scaffold-'));
    const wakeRoot = join(tempBase, 'my-project');
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const config = JSON.parse(await readFile(join(wakeRoot, 'config.json'), 'utf8'));

    expect(config.sandbox.containerName).toBe('wake-sandbox-my-project');
    expect(config.sandbox.image).toBe('wake-sandbox');
    expect(config.sandbox.imageRepository).toBe('wake-sandbox');
  });

  it('sanitizes an uppercase/space/special-character directory name for containerName', async () => {
    const tempBase = await mkdtemp(resolve(tmpdir(), 'wake-scaffold-'));
    const wakeRoot = join(tempBase, 'My Project! (v2)');
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const config = JSON.parse(await readFile(join(wakeRoot, 'config.json'), 'utf8'));

    expect(config.sandbox.containerName).toBe('wake-sandbox-my-project-v2');
  });

  it('trims leading and trailing underscores from containerName', async () => {
    const tempBase = await mkdtemp(resolve(tmpdir(), 'wake-scaffold-'));
    const wakeRoot = join(tempBase, '_my_project_');
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const config = JSON.parse(await readFile(join(wakeRoot, 'config.json'), 'utf8'));

    expect(config.sandbox.containerName).toBe('wake-sandbox-my_project');
  });
});
