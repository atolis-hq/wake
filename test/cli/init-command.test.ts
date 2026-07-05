import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { runInitCommand } from '../../src/cli/init-command.js';

describe('init command', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'wake-init-command-'));
  });

  it('scaffolds a wake home with config, prompts, docker assets, and runtime directories', async () => {
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
    const dockerfile = await readFile(join(result.wakeRoot, 'docker', 'Dockerfile'), 'utf8');
    const setupScript = await readFile(join(result.wakeRoot, 'docker', 'setup.sh'), 'utf8');
    const refinePrompt = await readFile(
      join(result.wakeRoot, 'prompts', 'refine.start.md'),
      'utf8',
    );

    expect(config).toContain('"sandbox"');
    expect(dockerfile).toContain('node dist/src/main.js start');
    expect(setupScript).toContain('gh auth login');
    expect(refinePrompt).toContain('stage: refine');

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
