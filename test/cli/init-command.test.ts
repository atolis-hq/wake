import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { runInitCommand } from '../../src/cli/init-command.js';

describe('init command', () => {
  const promptFiles = ['refine.md', 'implement.md'] as const;
  const launcherScripts = ['wake.sh', 'wake.ps1'] as const;
  const dataRootRuntimeDirectories = [
    'events',
    'state',
    'runs',
    'repos',
    'sources',
    'locks',
    'logs',
  ] as const;

  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'wake-init-command-'));
  });

  it('scaffolds a wake home with config, prompts, launchers, and runtime directories, without docker assets', async () => {
    const targetRoot = await mkdtemp(join(tempRoot, 'cwd-'));
    const homeDir = 'wake-home';
    const repoRoot = process.cwd();

    const result = await runInitCommand({
      cwd: targetRoot,
      args: [homeDir],
      repoRoot,
    });

    expect(result.wakeRoot).toBe(join(targetRoot, homeDir));

    const config = await readFile(join(result.wakeRoot, 'config.json'), 'utf8');
    const shellLauncher = await readFile(join(result.wakeRoot, 'wake.sh'), 'utf8');
    const powerShellLauncher = await readFile(join(result.wakeRoot, 'wake.ps1'), 'utf8');

    expect(config).toContain('"sandbox"');
    expect(config).toContain(`"repoRoot": "${repoRoot.replaceAll('\\', '\\\\')}"`);
    await expect(stat(join(result.wakeRoot, 'docker'))).rejects.toThrow();
    expect(shellLauncher).toContain('#!/usr/bin/env bash');
    expect(shellLauncher).toContain(
      'exec wake "$@" --wake-root "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    );
    expect(powerShellLauncher).toContain('& wake @args --wake-root $PSScriptRoot');
    expect(powerShellLauncher).toContain('exit $LASTEXITCODE');

    for (const promptFile of promptFiles) {
      const prompt = await readFile(join(result.wakeRoot, 'prompts', promptFile), 'utf8');
      expect(prompt.length).toBeGreaterThan(0);
    }

    expect(await readFile(join(result.wakeRoot, 'prompts', 'refine.md'), 'utf8')).toContain(
      'stage: refine',
    );

    for (const launcherScript of launcherScripts) {
      expect((await stat(join(result.wakeRoot, launcherScript))).isFile()).toBe(true);
    }

    for (const runtimeDirectory of dataRootRuntimeDirectories) {
      expect((await stat(join(result.wakeRoot, '.wake', runtimeDirectory))).isDirectory()).toBe(
        true,
      );
    }

    expect((await stat(join(result.wakeRoot, 'workspaces'))).isDirectory()).toBe(true);
  });

  it('rejects init when the target directory is not empty', async () => {
    const targetRoot = await mkdtemp(join(tempRoot, 'non-empty-'));
    await mkdir(join(targetRoot, 'occupied'));
    await writeFile(join(targetRoot, 'occupied', 'seed.txt'), 'seed\n', 'utf8');

    await expect(
      runInitCommand({
        cwd: targetRoot,
        args: [],
        repoRoot: process.cwd(),
      }),
    ).rejects.toThrow(/empty directory/i);
  });
});
