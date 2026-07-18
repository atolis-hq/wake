import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  loadPromptTemplate,
  renderPromptTemplate,
} from '../../src/adapters/runner/prompt-templates.js';
import { buildStagePrompt } from '../../src/adapters/runner/stage-prompt.js';

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

  it('renders the wake:work-item marker with the real work id, not the placeholder', async () => {
    // The marker only earns its keep if {{workItemKey}} is actually substituted.
    // renderPromptTemplate leaves an unknown token untouched rather than
    // failing, so dropping workItemKey from the render context would ship
    // `<!-- wake:work-item {{workItemKey}} -->` verbatim into real PR bodies —
    // a marker that looks present and carries nothing, with nothing to catch it.
    // Asserting the template merely *contains* the placeholder cannot see that;
    // this renders it and asserts the id survives.
    for (const mode of ['start', 'resume'] as const) {
      const template = await loadPromptTemplate('implement', mode);
      const rendered = renderPromptTemplate(template, {
        workItemKey: 'work-01JQZX9K2N4P6R8T0V2W4Y6A8C',
      });

      expect(rendered).toContain('<!-- wake:work-item work-01JQZX9K2N4P6R8T0V2W4Y6A8C -->');
      expect(rendered).not.toContain('{{workItemKey}}');
    }
  });

  it('stringifies non-string values passed as context', () => {
    const rendered = renderPromptTemplate(
      { frontmatter: {}, body: 'Events: {{events}}' },
      { events: [{ id: 'evt-1' }] },
    );

    expect(rendered).toContain('"id": "evt-1"');
  });

  it('instructs the agent to report PR artifacts', async () => {
    const projection = {
      schemaVersion: 1 as const,
      workItemKey: 'work-01JQZX9K2N4P6R8T0V2W4Y6A8C',
      issue: {
        repo: 'atolis-hq/wake',
        number: 12,
        title: 'Example issue',
        body: 'Body',
        labels: ['wake:implement'],
        assignees: [],
        isPullRequest: false,
        state: 'open' as const,
        url: 'https://example.test/issues/12',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'implement' as const,
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
        expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
      correlatedResources: [],
    };

    const result = await buildStagePrompt({
      action: 'implement',
      projection,
    });

    expect(result.harnessPrompt).toContain('wake-artifacts');
  });
});
