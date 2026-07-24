import { access, copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

  await mkdir(join(repoRoot, 'templates'), { recursive: true });
  await copyFile(join(cwd, 'templates', 'SETUP.md'), join(repoRoot, 'templates', 'SETUP.md'));

  return repoRoot;
}

async function makeTempWakeRoot(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), 'wake-scaffold-home-'));
}

describe('scaffoldWakeHome prompts', () => {
  it('copies every bundled prompt file, not a hardcoded subset', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const bundledPromptFiles = (await readdir(join(repoRoot, 'prompts'))).filter((name) =>
      name.endsWith('.md'),
    );
    const scaffoldedPromptFiles = await readdir(join(wakeRoot, 'prompts'));

    expect(scaffoldedPromptFiles.sort()).toEqual(bundledPromptFiles.sort());
    expect(scaffoldedPromptFiles).toEqual(
      expect.arrayContaining(['ask.md', 'codereview.md', 'implement.md', 'refine.md', 'revise.md']),
    );
  });
});

describe('scaffoldWakeHome launchers', () => {
  it('does not scaffold wake.sh or wake.ps1 — wake defaults --wake-root to cwd instead', async () => {
    const wakeRoot = await mkdtemp(resolve(tmpdir(), 'wake-scaffold-'));
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    await expect(access(resolve(wakeRoot, 'wake.sh'))).rejects.toThrow();
    await expect(access(resolve(wakeRoot, 'wake.ps1'))).rejects.toThrow();
  });
});

describe('scaffoldWakeHome config.yaml', () => {
  it('derives sandbox.containerName from the wake-root directory name', async () => {
    const tempBase = await mkdtemp(resolve(tmpdir(), 'wake-scaffold-'));
    const wakeRoot = join(tempBase, 'my-project');
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const config = parse(await readFile(join(wakeRoot, 'config.yaml'), 'utf8'));

    expect(config.sandbox.containerName).toBe('wake-sandbox-my-project');
    expect(config.sandbox.image).toBe('wake-sandbox');
    expect(config.sandbox.imageRepository).toBe('wake-sandbox');
  });

  it('sanitizes an uppercase/space/special-character directory name for containerName', async () => {
    const tempBase = await mkdtemp(resolve(tmpdir(), 'wake-scaffold-'));
    const wakeRoot = join(tempBase, 'My Project! (v2)');
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const config = parse(await readFile(join(wakeRoot, 'config.yaml'), 'utf8'));

    expect(config.sandbox.containerName).toBe('wake-sandbox-my-project-v2');
  });

  it('trims leading and trailing underscores from containerName', async () => {
    const tempBase = await mkdtemp(resolve(tmpdir(), 'wake-scaffold-'));
    const wakeRoot = join(tempBase, '_my_project_');
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const config = parse(await readFile(join(wakeRoot, 'config.yaml'), 'utf8'));

    expect(config.sandbox.containerName).toBe('wake-sandbox-my_project');
  });

  it('does not bake an absolute promptsRoot into config.yaml', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const config = parse(await readFile(join(wakeRoot, 'config.yaml'), 'utf8'));

    expect(config.paths.promptsRoot).toBeUndefined();
  });
});

describe('scaffoldWakeHome runtime directories', () => {
  it('creates .wake/-nested runtime directories, not flat top-level ones', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    await expect(access(join(wakeRoot, '.wake', 'events'))).resolves.toBeUndefined();
    await expect(access(join(wakeRoot, '.wake', 'state'))).resolves.toBeUndefined();
    await expect(access(join(wakeRoot, '.wake', 'runs'))).resolves.toBeUndefined();
    await expect(access(join(wakeRoot, '.wake', 'sources'))).resolves.toBeUndefined();
    await expect(access(join(wakeRoot, '.wake', 'locks'))).resolves.toBeUndefined();
    await expect(access(join(wakeRoot, '.wake', 'logs'))).resolves.toBeUndefined();
    await expect(access(join(wakeRoot, 'workspaces'))).resolves.toBeUndefined();
    await expect(access(join(wakeRoot, 'events'))).rejects.toThrow();
  });

  it('does not scaffold docker/ at all', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    await expect(access(join(wakeRoot, 'docker'))).rejects.toThrow();
  });
});

describe('scaffoldWakeHome SETUP.md', () => {
  it('copies templates/SETUP.md from repoRoot verbatim into the wake home root', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const scaffolded = await readFile(join(wakeRoot, 'SETUP.md'), 'utf8');
    const source = await readFile(join(repoRoot, 'templates', 'SETUP.md'), 'utf8');

    expect(scaffolded).toBe(source);
  });

  it('covers the GitHub source, runner/tier, and credential-mount sections', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const scaffolded = await readFile(join(wakeRoot, 'SETUP.md'), 'utf8');

    expect(scaffolded).toContain('sources:');
    expect(scaffolded).toContain('github:');
    expect(scaffolded).toContain('extraMounts');
    expect(scaffolded).toContain('.credentials.json');
    expect(scaffolded).toContain('defaultTier');
    expect(scaffolded).toContain(
      'https://github.com/atolis-hq/wake/blob/main/docs/configuration.md',
    );
    expect(scaffolded).toContain(
      'https://github.com/atolis-hq/wake/blob/main/docs/getting-started.md',
    );
  });

  it('contains no template placeholders — content is static, not interpolated', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const scaffolded = await readFile(join(wakeRoot, 'SETUP.md'), 'utf8');

    expect(scaffolded).not.toMatch(/\{\{.*\}\}/);
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

    const config = parse(await readFile(join(wakeRoot, 'config.yaml'), 'utf8'));
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

    const config = parse(await readFile(join(wakeRoot, 'config.yaml'), 'utf8'));
    expect(config.dev.mode).toBe('packaged');
  });
});
