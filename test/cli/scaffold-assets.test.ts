import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

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
