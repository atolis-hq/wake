import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialiseWakeRoot } from '../../src-next/bootstrap/initialise.js';

describe('target initialise root', () => {
  it('creates the visible sandbox build asset and all target runtime roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);
    await expect(readFile(join(root, 'docker', 'Dockerfile'), 'utf8')).resolves.toContain('FROM');
    const config = await readFile(join(root, 'config.yaml'), 'utf8');
    expect(config).toContain('host:');
    expect(config).toContain('sandbox:');
    expect(config).toContain('containerName: wake-sandbox');
    expect(await readdir(join(root, '.wake'))).toEqual(
      expect.arrayContaining([
        'events',
        'projections',
        'checkpoints',
        'locks',
        'transcripts',
        'logs',
      ]),
    );
  });
});
