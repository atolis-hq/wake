import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPromptTemplate, renderPromptTemplate } from '../../../src/execution/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
});

describe('E2E-PROMPT-001 loadPromptTemplate', () => {
  it('parses typed YAML frontmatter from the Wake root prompts directory', async () => {
    const root = await fixtureRoot();
    await writeFile(
      join(root, 'prompts', 'implement.md'),
      '---\nmodel: gpt-5\nmaxTurns: 40\nallowedTools:\n  - Bash(git *)\nextraArgs:\n---\nImplement {{objective}}.',
    );

    await expect(loadPromptTemplate(root, 'implement')).resolves.toEqual({
      name: 'implement',
      body: 'Implement {{objective}}.',
      frontmatter: {
        model: 'gpt-5',
        maxTurns: 40,
        allowedTools: ['Bash(git *)'],
        extraArgs: null,
      },
    });
  });

  it('rejects unrecognized frontmatter instead of silently ignoring an operator edit', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'prompts', 'implement.md'), '---\nmax_turns: 40\n---\nBody');

    await expect(loadPromptTemplate(root, 'implement')).rejects.toThrow('max_turns');
  });

  it('names the template when YAML cannot be parsed', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'prompts', 'implement.md'), '---\nallowedTools: [\n---\nBody');

    await expect(loadPromptTemplate(root, 'implement')).rejects.toThrow('implement.md');
  });

  it('renders the parsed template against an explicit context', async () => {
    const root = await fixtureRoot();
    await writeFile(
      join(root, 'prompts', 'implement.md'),
      '---\nmodel: gpt-5\n---\nImplement {{objective}}.',
    );

    const template = await loadPromptTemplate(root, 'implement');

    expect(renderPromptTemplate(template, { objective: 'the change' })).toBe(
      'Implement the change.',
    );
  });

  it('accepts an empty YAML frontmatter document', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'prompts', 'implement.md'), '---\n---\nBody');

    await expect(loadPromptTemplate(root, 'implement')).resolves.toMatchObject({
      frontmatter: {},
      body: 'Body',
    });
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-prompt-template-'));
  roots.push(root);
  await writeFile(join(root, '.keep'), '');
  await (await import('node:fs/promises')).mkdir(join(root, 'prompts'));
  return root;
}
