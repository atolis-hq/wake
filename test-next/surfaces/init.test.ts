import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialiseWakeHome } from '../../src-next/surfaces/cli/commands/init.js';

describe('init', () => {
  it('creates visible assets and target runtime directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-init-'));
    await initialiseWakeHome(root, {
      'config.yaml': 'execution: {}\n',
      'config.workflows.yaml': 'orchestration: {}\n',
      'prompts/implement.md': '# implement\n',
    });
    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        'config.yaml',
        'config.workflows.yaml',
        'prompts',
        'workspaces',
        '.wake',
      ]),
    );
    expect(await readdir(join(root, '.wake'))).toEqual(
      expect.arrayContaining(['events', 'projections', 'checkpoints', 'locks', 'transcripts']),
    );
  });
});
