import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectDevMode, scaffoldWakeHome } from '../../src/cli/scaffold-assets.js';

async function makeSourceRepoRoot(): Promise<string> {
  const repoRoot = await mkdtemp(resolve(tmpdir(), 'wake-scaffold-repo-source-'));
  await mkdir(join(repoRoot, 'src'), { recursive: true });
  await writeFile(join(repoRoot, 'src', 'main.ts'), '// main\n', 'utf8');
  await writeFile(join(repoRoot, 'tsconfig.json'), '{}\n', 'utf8');
  return repoRoot;
}

async function makePackagedRepoRoot(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), 'wake-scaffold-repo-packaged-'));
}

async function makeScaffoldableRepoRoot(hasSrcCheckout: boolean): Promise<string> {
  const repoRoot = hasSrcCheckout ? await makeSourceRepoRoot() : await makePackagedRepoRoot();
  const cwd = process.cwd();

  await mkdir(join(repoRoot, 'prompts'), { recursive: true });
  for (const promptFile of ['refine.md', 'implement.md']) {
    await copyFile(join(cwd, 'prompts', promptFile), join(repoRoot, 'prompts', promptFile));
  }

  await mkdir(join(repoRoot, 'docker'), { recursive: true });
  for (const dockerAsset of ['Dockerfile', 'setup.sh', 'log-command.sh']) {
    await copyFile(join(cwd, 'docker', dockerAsset), join(repoRoot, 'docker', dockerAsset));
  }

  return repoRoot;
}

async function makeTempWakeRoot(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), 'wake-scaffold-home-'));
}

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

describe('detectDevMode', () => {
  it('returns "source" when repoRoot has src/main.ts and tsconfig.json', async () => {
    const repoRoot = await makeSourceRepoRoot();

    const mode = await detectDevMode(repoRoot);

    expect(mode).toBe('source');
  });

  it('returns "packaged" when repoRoot has no src/ or tsconfig.json', async () => {
    const repoRoot = await makePackagedRepoRoot();

    const mode = await detectDevMode(repoRoot);

    expect(mode).toBe('packaged');
  });
});

describe('scaffoldWakeHome dev.mode', () => {
  it('records the detected dev.mode into config.json', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = await makeScaffoldableRepoRoot(true);

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const config = JSON.parse(await readFile(join(wakeRoot, 'config.json'), 'utf8'));
    expect(config.dev.mode).toBe('source');
  });

  it('honors an explicit devModeOverride regardless of repoRoot contents', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = await makeScaffoldableRepoRoot(true);

    await scaffoldWakeHome({
      wakeRoot,
      repoRoot,
      devModeOverride: 'packaged',
    });

    const config = JSON.parse(await readFile(join(wakeRoot, 'config.json'), 'utf8'));
    expect(config.dev.mode).toBe('packaged');
  });
});
