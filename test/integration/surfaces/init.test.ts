import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialiseWakeHome } from '../../../src/surfaces/cli/commands/init.js';

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

  it("writes each asset's exact given content, not just its presence", async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-init-'));
    await initialiseWakeHome(root, {
      'config.yaml': 'schemaVersion: 1\nexecution: {}\n',
      'config.workflows.yaml': 'orchestration: {}\n',
      'prompts/implement.md': '---\nmaxTurns: 5\n---\nImplement.\n',
      'nested/deep/asset.txt': 'nested content\n',
    });

    await expect(readFile(join(root, 'config.yaml'), 'utf8')).resolves.toBe(
      'schemaVersion: 1\nexecution: {}\n',
    );
    await expect(readFile(join(root, 'config.workflows.yaml'), 'utf8')).resolves.toBe(
      'orchestration: {}\n',
    );
    await expect(readFile(join(root, 'prompts', 'implement.md'), 'utf8')).resolves.toBe(
      '---\nmaxTurns: 5\n---\nImplement.\n',
    );
    await expect(readFile(join(root, 'nested', 'deep', 'asset.txt'), 'utf8')).resolves.toBe(
      'nested content\n',
    );
  });

  it('refuses a non-empty root without replacing an operator-customized asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-init-'));
    const customConfig = 'operator-owned: preserve me\n';
    await writeFile(join(root, 'config.yaml'), customConfig, 'utf8');

    await expect(
      initialiseWakeHome(root, {
        'config.yaml': 'schemaVersion: 1\n',
        'prompts/implement.md': '# generated\n',
      }),
    ).rejects.toThrow(`Wake root is not empty: ${root}`);

    await expect(readFile(join(root, 'config.yaml'), 'utf8')).resolves.toBe(customConfig);
    await expect(readdir(root)).resolves.toEqual(['config.yaml']);
  });
});
