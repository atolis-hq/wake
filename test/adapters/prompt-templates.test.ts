import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  loadPromptTemplate,
  renderPromptTemplate,
} from '../../src/adapters/runner/prompt-templates.js';

describe('prompt templates', () => {
  it('parses frontmatter and body from a stage/mode template file', async () => {
    const template = await loadPromptTemplate('refine', 'start');

    expect(template.frontmatter.stage).toBe('refine');
    expect(template.frontmatter.permissionMode).toBe('default');
    expect(template.body).toContain('{{workItemKey}}');
  });

  it('loads all bundled stage/mode combinations from combined templates', async () => {
    await expect(loadPromptTemplate('refine', 'start')).resolves.toBeDefined();
    await expect(loadPromptTemplate('refine', 'resume')).resolves.toBeDefined();
    await expect(loadPromptTemplate('implement', 'start')).resolves.toBeDefined();
    await expect(loadPromptTemplate('implement', 'resume')).resolves.toBeDefined();
  });

  it('instructs the agent to embed the wake:work-item marker verbatim in PR bodies it creates', async () => {
    const startTemplate = await loadPromptTemplate('implement', 'start');
    expect(startTemplate.body).toContain('<!-- wake:work-item {{workItemKey}} -->');

    const resumeTemplate = await loadPromptTemplate('implement', 'resume');
    expect(resumeTemplate.body).toContain('<!-- wake:work-item {{workItemKey}} -->');
  });

  it('loads a combined template from an explicit prompts root', async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), 'wake-prompts-'));
    await writeFile(
      join(promptsDir, 'refine.md'),
      '---\nstage: refine\n---\nCustom {{mode}} prompt body',
      'utf8',
    );

    const template = await loadPromptTemplate('refine', 'start', {
      promptsRoot: promptsDir,
    });

    expect(template.body).toBe('Custom {{mode}} prompt body');
  });

  it('falls back to legacy stage/mode templates when no combined template exists', async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), 'wake-prompts-'));
    await writeFile(
      join(promptsDir, 'refine.start.md'),
      '---\nstage: refine\nmode: start\n---\nLegacy prompt body',
      'utf8',
    );

    const template = await loadPromptTemplate('refine', 'start', {
      promptsRoot: promptsDir,
    });

    expect(template.frontmatter.mode).toBe('start');
    expect(template.body).toBe('Legacy prompt body');
  });

  it('renders handlebars conditionals and lists', () => {
    const rendered = renderPromptTemplate(
      {
        frontmatter: {},
        body: '{{#if isStart}}Start{{else}}Resume{{/if}}:{{#each tools}} {{this}}{{/each}}',
      },
      { isStart: false, tools: ['Read', 'Grep'] },
    );

    expect(rendered).toBe('Resume: Read Grep');
  });

  it('stringifies non-string values passed as context', () => {
    const rendered = renderPromptTemplate(
      { frontmatter: {}, body: 'Events: {{events}}' },
      { events: [{ id: 'evt-1' }] },
    );

    expect(rendered).toContain('"id": "evt-1"');
  });
});
