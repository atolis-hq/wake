import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  loadPromptTemplate,
  renderPromptTemplate,
} from '../../src/adapters/claude/prompt-templates.js';

describe('prompt templates', () => {
  it('parses frontmatter and body from a stage/mode template file', async () => {
    const template = await loadPromptTemplate('refine', 'start');

    expect(template.frontmatter.stage).toBe('refine');
    expect(template.frontmatter.mode).toBe('start');
    expect(template.body).toContain('{{workItemKey}}');
  });

  it('loads all four stage/mode combinations wake ships', async () => {
    await expect(loadPromptTemplate('refine', 'resume')).resolves.toBeDefined();
    await expect(loadPromptTemplate('implement', 'start')).resolves.toBeDefined();
    await expect(loadPromptTemplate('implement', 'resume')).resolves.toBeDefined();
  });

  it('loads a template from an explicit prompts root', async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), 'wake-prompts-'));
    await writeFile(
      join(promptsDir, 'refine.start.md'),
      '---\nstage: refine\nmode: start\n---\nCustom prompt body',
      'utf8',
    );

    const template = await loadPromptTemplate('refine', 'start', {
      promptsRoot: promptsDir,
    });

    expect(template.body).toBe('Custom prompt body');
  });

  it('substitutes known tokens and leaves unknown ones untouched', () => {
    const rendered = renderPromptTemplate(
      { frontmatter: {}, body: 'Issue #{{issueNumber}}: {{title}}. Unknown: {{missing}}' },
      { issueNumber: 8, title: 'Fix the thing' },
    );

    expect(rendered).toBe('Issue #8: Fix the thing. Unknown: {{missing}}');
  });

  it('stringifies non-string values passed as context', () => {
    const rendered = renderPromptTemplate(
      { frontmatter: {}, body: 'Events: {{events}}' },
      { events: [{ id: 'evt-1' }] },
    );

    expect(rendered).toContain('"id": "evt-1"');
  });
});
