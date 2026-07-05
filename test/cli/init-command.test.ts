import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { runInitCommand } from '../../src/cli/init-command.js';

describe('init command', () => {
  const promptFiles = [
    'refine.start.md',
    'refine.resume.md',
    'implement.start.md',
    'implement.resume.md',
  ] as const;
  const dockerAssets = ['Dockerfile', 'setup.sh'] as const;
  const runtimeDirectories = [
    'events',
    'state',
    'runs',
    'workspaces',
    'repos',
    'sources',
    'locks',
  ] as const;

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

    expect(config).toContain('"sandbox"');
    expect(dockerfile).toContain(
      'ENTRYPOINT ["node", "/app/dist/src/main.js", "start", "--wake-root", "/wake"]',
    );
    expect(setupScript).toContain('gh auth login');
    expect(setupScript).not.toContain('docker exec');
    expect(setupScript).toContain('claude setup-token');
    expect(setupScript).toContain('ssh-keygen -t ed25519');

    for (const promptFile of promptFiles) {
      const prompt = await readFile(join(result.wakeRoot, 'prompts', promptFile), 'utf8');
      expect(prompt.length).toBeGreaterThan(0);
    }

    expect(
      await readFile(join(result.wakeRoot, 'prompts', 'refine.start.md'), 'utf8'),
    ).toContain('stage: refine');

    for (const dockerAsset of dockerAssets) {
      expect((await stat(join(result.wakeRoot, 'docker', dockerAsset))).isFile()).toBe(true);
    }

    for (const runtimeDirectory of runtimeDirectories) {
      expect((await stat(join(result.wakeRoot, runtimeDirectory))).isDirectory()).toBe(true);
    }
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
