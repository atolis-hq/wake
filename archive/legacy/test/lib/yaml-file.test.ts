import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readYamlFile, writeYamlFile } from '../../src/lib/yaml-file.js';

describe('yaml-file', () => {
  it('round-trips an object through writeYamlFile and readYamlFile', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-yaml-file-'));
    const path = join(dir, 'nested', 'example.yaml');

    await writeYamlFile(path, { schemaVersion: 1, sandbox: { image: 'wake-sandbox' } });
    const result = await readYamlFile<{ schemaVersion: number; sandbox: { image: string } }>(path);

    expect(result).toEqual({ schemaVersion: 1, sandbox: { image: 'wake-sandbox' } });
  });

  it('writes human-readable YAML, not JSON', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-yaml-file-'));
    const path = join(dir, 'example.yaml');

    await writeYamlFile(path, { sandbox: { image: 'wake-sandbox' } });
    const raw = await readFile(path, 'utf8');

    expect(raw).toContain('sandbox:');
    expect(raw).toContain('image: wake-sandbox');
    expect(raw).not.toContain('{');
  });
});
