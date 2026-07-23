import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverConfigFiles } from '../../src/config/discover-config-files.js';

describe('discoverConfigFiles', () => {
  it('finds config.yaml and config.<label>.yaml but not unrelated files', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-discover-config-'));
    await writeFile(join(dir, 'config.yaml'), '', 'utf8');
    await writeFile(join(dir, 'config.workflows.yaml'), '', 'utf8');
    await writeFile(join(dir, 'config.local.yaml'), '', 'utf8');
    await writeFile(join(dir, 'config.json'), '', 'utf8');
    await writeFile(join(dir, 'configuration.yaml'), '', 'utf8');
    await writeFile(join(dir, 'config.yaml.abc123.tmp'), '', 'utf8');
    await mkdir(join(dir, 'workspaces'), { recursive: true });

    const found = await discoverConfigFiles(dir);

    expect(found).toEqual([
      join(dir, 'config.local.yaml'),
      join(dir, 'config.workflows.yaml'),
      join(dir, 'config.yaml'),
    ]);
  });

  it('returns an empty array when the directory has no config*.yaml files', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-discover-config-'));

    const found = await discoverConfigFiles(dir);

    expect(found).toEqual([]);
  });

  it('returns an empty array when the directory does not exist', async () => {
    const found = await discoverConfigFiles(resolve('/nonexistent/wake-home'));

    expect(found).toEqual([]);
  });
});
