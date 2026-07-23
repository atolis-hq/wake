import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadWakeConfig } from '../../src/config/load-config.js';
import { scaffoldWakeHome } from '../../src/cli/scaffold-assets.js';

describe('loadWakeConfig', () => {
  it('always resolves paths.wakeRoot from the passed-in wakeRoot, never from a stale config file value', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    // Simulate a wake-home whose config.yaml still has an old
    // container-context wakeRoot baked in (e.g. "/wake") from before this
    // config was ever read directly on the host.
    await writeFile(
      join(dir, 'config.yaml'),
      'paths:\n  wakeRoot: /wake\n  promptsRoot: /wake/prompts\n',
      'utf8',
    );

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.paths.wakeRoot).toBe(dir);
  });

  it('still honors an explicit promptsRoot override from config.yaml', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    const customPromptsRoot = join(dir, 'custom-prompts');
    await writeFile(
      join(dir, 'config.yaml'),
      `paths:\n  promptsRoot: ${customPromptsRoot}\n`,
      'utf8',
    );

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.paths.promptsRoot).toBe(customPromptsRoot);
    expect(config.paths.wakeRoot).toBe(dir);
  });

  it('deep-merges every config*.yaml file present, sorted by filename', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    await writeFile(join(dir, 'config.yaml'), 'sandbox:\n  image: custom-image\n', 'utf8');
    await writeFile(join(dir, 'config.workflows.yaml'), 'defaultTier: deep\n', 'utf8');
    await writeFile(
      join(dir, 'config.sources.yaml'),
      'sources:\n  github:\n    enabled: true\n    repos: [org/repo]\n',
      'utf8',
    );

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.sandbox.image).toBe('custom-image');
    expect(config.defaultTier).toBe('deep');
    expect(config.sources.github.enabled).toBe(true);
    expect(config.sources.github.repos).toEqual(['org/repo']);
  });

  it('falls back to a legacy combined config.json when no config*.yaml file exists', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ sandbox: { image: 'legacy-image' }, defaultTier: 'deep' }),
      'utf8',
    );

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.sandbox.image).toBe('legacy-image');
    expect(config.defaultTier).toBe('deep');
  });

  it('ignores the legacy config.json once any config*.yaml file exists', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ sandbox: { image: 'legacy-image' } }),
      'utf8',
    );
    await writeFile(join(dir, 'config.yaml'), 'sandbox:\n  image: current-image\n', 'utf8');

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.sandbox.image).toBe('current-image');
  });

  it('tolerates an empty or comment-only config*.yaml file without throwing', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    await writeFile(join(dir, 'config.yaml'), 'sandbox:\n  image: custom-image\n', 'utf8');
    await writeFile(join(dir, 'config.local.yaml'), '# nothing here\n', 'utf8');

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.sandbox.image).toBe('custom-image');
  });

  it('names the offending file when a config*.yaml fails to parse', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    await writeFile(join(dir, 'config.yaml'), 'sandbox:\n  image: custom-image\n', 'utf8');
    const badFile = join(dir, 'config.broken.yaml');
    await writeFile(badFile, 'sandbox:\n  image: [unterminated\n', 'utf8');

    await expect(loadWakeConfig({ wakeRoot: dir })).rejects.toThrow(badFile);
  });

  it('loads correctly from a wake home produced by scaffoldWakeHome', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    const repoRoot = resolve(__dirname, '..', '..');

    await scaffoldWakeHome({ wakeRoot: dir, repoRoot });

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.sandbox.containerName).toBe(`wake-sandbox-${basename(dir).toLowerCase()}`);
    expect(Object.keys(config.runners).length).toBeGreaterThan(0);
    expect(config.defaultTier).toBe('standard');
  });

  it('lets the later-sorted config*.yaml file win when both set the same key', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    await writeFile(join(dir, 'config.yaml'), 'defaultTier: standard\n', 'utf8');
    await writeFile(join(dir, 'config.zzz-override.yaml'), 'defaultTier: deep\n', 'utf8');

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.defaultTier).toBe('deep');
  });
});
