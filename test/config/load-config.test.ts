import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadWakeConfig } from '../../src/config/load-config.js';

describe('loadWakeConfig', () => {
  it('always resolves paths.wakeRoot from the passed-in wakeRoot, never from a stale config file value', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    const configFile = join(dir, 'config.json');
    // Simulate a wake-home whose config.json still has an old
    // container-context wakeRoot baked in (e.g. "/wake") from before this
    // config was ever read directly on the host.
    await writeFile(
      configFile,
      JSON.stringify({ paths: { wakeRoot: '/wake', promptsRoot: '/wake/prompts' } }),
      'utf8',
    );

    const config = await loadWakeConfig({ wakeRoot: dir, configFile });

    expect(config.paths.wakeRoot).toBe(dir);
  });

  it('still honors an explicit promptsRoot override from the config file', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    const configFile = join(dir, 'config.json');
    const customPromptsRoot = join(dir, 'custom-prompts');
    await writeFile(
      configFile,
      JSON.stringify({ paths: { promptsRoot: customPromptsRoot } }),
      'utf8',
    );

    const config = await loadWakeConfig({ wakeRoot: dir, configFile });

    expect(config.paths.promptsRoot).toBe(customPromptsRoot);
    expect(config.paths.wakeRoot).toBe(dir);
  });
});
