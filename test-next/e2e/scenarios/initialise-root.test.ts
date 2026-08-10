import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { main } from '../../../src-next/main.js';
import { defineScenario } from '../support/scenario.js';

defineScenario(
  {
    id: 'E2E-OPS-INIT-001',
    title: 'the public init command creates a runnable Wake root without composing a runtime first',
    given: ['an empty operator-selected directory'],
    when: ['the target CLI receives init with that directory'],
    then: ['configuration, prompts, sandbox asset, and private runtime roots exist'],
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-e2e-init-'));
    const output: string[] = [];

    await main(['init', '--wake-root', root], {
      compose: async () => {
        throw new Error('init must not compose a runtime');
      },
      output: { write: (value) => output.push(value) },
      signal: new AbortController().signal,
    });

    expect(JSON.parse(output.join(''))).toMatchObject({ wakeRoot: root });
    await expect(readFile(join(root, 'config.yaml'), 'utf8')).resolves.toContain(
      'schemaVersion: 1',
    );
    await expect(readFile(join(root, 'prompts', 'refine.md'), 'utf8')).resolves.toContain('---');
    await expect(readFile(join(root, 'docker', 'Dockerfile'), 'utf8')).resolves.toContain('FROM');
    expect(await readdir(join(root, '.wake'))).toEqual(
      expect.arrayContaining(['events', 'projections', 'checkpoints', 'transcripts']),
    );
  },
);
