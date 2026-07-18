import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  loadPromptTemplate,
  renderPromptTemplate,
} from '../../src/adapters/runner/prompt-templates.js';
import { buildStagePrompt } from '../../src/adapters/runner/stage-prompt.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';

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

  it('instructs the agent to report PR artifacts when PR tracking is enabled', async () => {
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

    const config = createDefaultWakeConfig(process.cwd());
    config.sources.github.enabled = true;
    config.sources.github.pullRequests.enabled = true;

    const result = await buildStagePrompt({
      action: 'implement',
      projection,
      config,
    });

    expect(result.harnessPrompt).toContain('wake-artifacts');
  });

  it('omits the wake-artifacts instruction when PR tracking is disabled', async () => {
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

    const config = createDefaultWakeConfig(process.cwd());
    config.sources.github.enabled = true;
    config.sources.github.pullRequests.enabled = false;

    const result = await buildStagePrompt({
      action: 'implement',
      projection,
      config,
    });

    expect(result.harnessPrompt).not.toContain('wake-artifacts');

    // No config at all is the same as PR tracking not being configured on —
    // it must not silently opt every caller in.
    const resultNoConfig = await buildStagePrompt({
      action: 'implement',
      projection,
    });
    expect(resultNoConfig.harnessPrompt).not.toContain('wake-artifacts');
  });

  it('renders review-thread anchoring for a PR review comment', async () => {
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
      comments: [
        {
          id: 'rc-1',
          body: 'Please fix this null check',
          author: { login: 'reviewer' },
          createdAt: '2026-07-18T00:00:00Z',
          updatedAt: '2026-07-18T00:00:00Z',
          isBotAuthored: false,
          resourceUri: 'github:pr-review-thread:org/repo#91/rt_1',
          reviewThread: { path: 'src/foo.ts', line: 42 },
        },
      ],
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
      mode: 'resume',
      projection,
    });

    expect(result.prompt).toContain('src/foo.ts:42');
  });

  it('renders review-thread anchoring without line number', async () => {
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
      comments: [
        {
          id: 'rc-2',
          body: 'This needs review',
          author: { login: 'reviewer' },
          createdAt: '2026-07-18T00:00:00Z',
          updatedAt: '2026-07-18T00:00:00Z',
          isBotAuthored: false,
          resourceUri: 'github:pr-review-thread:org/repo#91/rt_2',
          reviewThread: { path: 'src/foo.ts' },
        },
      ],
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
      mode: 'resume',
      projection,
    });

    expect(result.prompt).toContain('Surface: review comment on src/foo.ts');
    expect(result.prompt).not.toContain('src/foo.ts:');
  });

  it('renders resource URI surface when no review thread present', async () => {
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
      comments: [
        {
          id: 'rc-3',
          body: 'Comment from PR',
          author: { login: 'reviewer' },
          createdAt: '2026-07-18T00:00:00Z',
          updatedAt: '2026-07-18T00:00:00Z',
          isBotAuthored: false,
          resourceUri: 'github:pr:org/repo#91',
        },
      ],
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
      mode: 'resume',
      projection,
    });

    expect(result.prompt).toContain('Surface: github:pr:org/repo#91');
  });

  it('renders default issue-thread surface when no review thread or resource URI', async () => {
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
      comments: [
        {
          id: 'rc-4',
          body: 'Regular issue comment',
          author: { login: 'user' },
          createdAt: '2026-07-18T00:00:00Z',
          updatedAt: '2026-07-18T00:00:00Z',
          isBotAuthored: false,
        },
      ],
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
      mode: 'resume',
      projection,
    });

    expect(result.prompt).toContain('Surface: issue thread');
  });
});
