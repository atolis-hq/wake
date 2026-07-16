import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { platform } from 'node:process';

import { describe, expect, it } from 'vitest';

import {
  buildStagePrompt,
  buildClaudePrintArgs,
  buildClaudeRemoteControlArgs,
  buildEddySessionName,
  classifyClaudeCliFailure,
  createClaudeRunner,
  formatClaudeRunLogLine,
  runClaudeCommand,
} from '../../src/adapters/claude/claude-runner.js';
import { createDefaultWakeConfig, defaultSmokePrompt } from '../../src/config/defaults.js';

describe('claude runner command building', () => {
  const baseProjection = {
    schemaVersion: 1 as const,
    workItemKey: 'atolis-hq/wake#12',
    issue: {
      repo: 'atolis-hq/wake',
      number: 12,
      title: 'Example issue',
      body: 'Body',
      labels: ['wake:refine'],
      assignees: [],
      isPullRequest: false,
      state: 'open' as const,
      url: 'https://example.test/issues/12',
      createdAt: '2026-07-05T12:00:00.000Z',
      updatedAt: '2026-07-05T12:00:00.000Z',
    },
    comments: [],
    wake: {
      stage: 'refine' as const,
      stageHistory: [],
      recentEventIds: [],
      syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
    },
    context: {},
  };

  it('builds a minimal haiku print invocation for smoke tests', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: defaultSmokePrompt,
      sessionName: 'Eddy',
    });

    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args.at(-1)).toBe(defaultSmokePrompt);
  });

  it('builds a remote-control smoke invocation', () => {
    const args = buildClaudeRemoteControlArgs({
      model: 'haiku',
      prompt: defaultSmokePrompt,
      remoteControlName: 'Eddy',
      sessionName: 'Eddy',
    });

    expect(args).toContain('--remote-control');
    expect(args).toContain('--bg');
    expect(args.at(-1)).toBe(defaultSmokePrompt);
  });

  it('assembles a stage prompt from a projection summary and its comments', async () => {
    const result = await buildStagePrompt({
      action: 'implement',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#12',
        issue: {
          repo: 'atolis-hq/wake',
          number: 12,
          title: 'Example issue',
          body: 'Body',
          labels: ['wake:refine'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/12',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [
          {
            id: 'c-2',
            body: 'Please proceed',
            author: { login: 'shared-user' },
            createdAt: '2026-07-05T12:01:00.000Z',
            updatedAt: '2026-07-05T12:01:00.000Z',
            isBotAuthored: false,
          },
        ],
        latestComment: {
          id: 'c-2',
          body: 'Please proceed',
          author: { login: 'shared-user' },
          createdAt: '2026-07-05T12:01:00.000Z',
          updatedAt: '2026-07-05T12:01:00.000Z',
          isBotAuthored: false,
        },
        wake: {
          stage: 'refine',
          stageHistory: [],
          recentEventIds: ['evt-1'],
          syncedAt: '2026-07-05T12:01:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
      },
    });

    expect(result.prompt).toContain('IMPLEMENT stage');
    expect(result.prompt).toContain('atolis-hq/wake#12');
    expect(result.prompt).toContain('shared-user');
    expect(result.prompt).toContain('Please proceed');
    expect(result.prompt).toContain('<wake-untrusted-data>');
    expect(result.prompt).toContain('wake/issue-12');
    expect(result.prompt).toContain('git push -u origin wake/issue-12');
    expect(result.prompt).toContain('gh pr create');
    expect(result.prompt).toContain('Closes #12');
    expect(result.permissionMode).toBe('acceptEdits');
    expect(result.allowedTools).toContain('Edit');
    expect(result.allowedTools).toContain('Bash(git *)');
    expect(result.extraArgs).toEqual([]);
  });

  it('requires AWAITING_APPROVAL, not DONE, for successful built-in prompts when approval is required', async () => {
    for (const action of ['refine', 'implement'] as const) {
      for (const mode of ['start', 'resume'] as const) {
        const result = await buildStagePrompt({
          action,
          mode,
          projection: baseProjection,
        });

        expect(result.harnessPrompt).toContain('must be exactly one of:');
        expect(result.harnessPrompt).toContain('AWAITING_APPROVAL, BLOCKED, FAILED');
        expect(result.harnessPrompt).not.toContain('DONE, BLOCKED, FAILED');
        expect(result.harnessPrompt).toContain('- AWAITING_APPROVAL: the stage objective is complete');
        expect(result.harnessPrompt).not.toContain('- DONE:');
        expect(result.prompt).not.toContain('must be exactly one of:');
        expect(result.prompt).not.toContain('AWAITING_APPROVAL, BLOCKED, FAILED');
      }
    }
  });

  it('allows DONE as the success sentinel only when a template opts out of approval', async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), 'wake-prompts-'));
    await writeFile(
      join(promptsDir, 'refine.start.md'),
      [
        '---',
        'permissionMode: default',
        'allowedTools: Read',
        'maxTurns: 10',
        'skipApproval: true',
        '---',
        'Custom stage instruction for {{workItemKey}}.',
      ].join('\n'),
      'utf8',
    );

    const result = await buildStagePrompt({
      action: 'refine',
      projection: baseProjection,
      config: {
        ...createDefaultWakeConfig('/tmp/wake'),
        paths: { wakeRoot: '/tmp/wake', promptsRoot: promptsDir },
      },
    });

    expect(result.harnessPrompt).toContain('DONE, BLOCKED, FAILED');
    expect(result.harnessPrompt).toContain('- DONE: the stage objective is complete.');
    expect(result.harnessPrompt).not.toContain('AWAITING_APPROVAL');
    expect(result.prompt).toContain('Custom stage instruction for atolis-hq/wake#12.');
  });

  it('resume prompts only surface new human comments since the last handled one, not the full history', async () => {
    const result = await buildStagePrompt({
      action: 'refine',
      mode: 'resume',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#20',
        issue: {
          repo: 'atolis-hq/wake',
          number: 20,
          title: 'Example issue',
          body: 'Body',
          labels: [],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/20',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [
          {
            id: 'c-1',
            body: 'Already handled reply',
            author: { login: 'alice' },
            createdAt: '2026-07-05T12:01:00.000Z',
            updatedAt: '2026-07-05T12:01:00.000Z',
            isBotAuthored: false,
          },
          {
            id: 'c-2',
            body: 'Wake status update',
            author: { login: 'eddy-bot' },
            createdAt: '2026-07-05T12:02:00.000Z',
            updatedAt: '2026-07-05T12:02:00.000Z',
            isBotAuthored: true,
          },
          {
            id: 'c-3',
            body: 'CI comment',
            author: { login: 'ci-bot' },
            createdAt: '2026-07-05T12:03:00.000Z',
            updatedAt: '2026-07-05T12:03:00.000Z',
            isBotAuthored: true,
          },
          {
            id: 'c-4',
            body: 'New human reply',
            author: { login: 'bob' },
            createdAt: '2026-07-05T12:04:00.000Z',
            updatedAt: '2026-07-05T12:04:00.000Z',
            isBotAuthored: false,
          },
        ],
        wake: {
          stage: 'refine',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:04:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: { lastHandledCommentId: 'c-1' },
      },
    });

    // Resume prompts must not repeat the full comment history - the session
    // already has it - only what's new since the last handled comment.
    expect(result.prompt).toContain('<wake-untrusted-data>');
    expect(result.prompt).not.toContain('alice');
    expect(result.prompt).not.toContain('Already handled reply');
    expect(result.prompt).not.toContain('Wake status update');
    expect(result.prompt).not.toContain('CI comment');
    expect(result.prompt).toContain('bob');
    expect(result.prompt).toContain('New human reply');
  });

  it('adds a trusted resume note for explicit /question comments', async () => {
    const result = await buildStagePrompt({
      action: 'implement',
      mode: 'resume',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#22',
        issue: {
          repo: 'atolis-hq/wake',
          number: 22,
          title: 'Example issue',
          body: 'Body',
          labels: [],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/22',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [
          {
            id: 'c-1',
            body: 'Already handled reply',
            author: { login: 'alice' },
            createdAt: '2026-07-05T12:01:00.000Z',
            updatedAt: '2026-07-05T12:01:00.000Z',
            isBotAuthored: false,
          },
          {
            id: 'c-2',
            body: '/question What did you change?',
            author: { login: 'bob' },
            createdAt: '2026-07-05T12:04:00.000Z',
            updatedAt: '2026-07-05T12:04:00.000Z',
            isBotAuthored: false,
          },
        ],
        wake: {
          stage: 'implement',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:04:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: { lastHandledCommentId: 'c-1' },
      },
    });

    expect(result.prompt).toContain('The latest actionable command is `/question`.');
    expect(result.prompt).toContain('Do not make code changes solely because of this command');
    expect(result.prompt).toContain('/question What did you change?');
  });

  it('start prompts make new comments prominent while preserving prior comment context', async () => {
    const result = await buildStagePrompt({
      action: 'implement',
      mode: 'start',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#21',
        issue: {
          repo: 'atolis-hq/wake',
          number: 21,
          title: 'Example issue',
          body: 'Body',
          labels: [],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/21',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [
          {
            id: 'c-1',
            body: 'Earlier human context',
            author: { login: 'alice' },
            createdAt: '2026-07-05T12:01:00.000Z',
            updatedAt: '2026-07-05T12:01:00.000Z',
            isBotAuthored: false,
          },
          {
            id: 'c-2',
            body: 'Wake status update',
            author: { login: 'eddy-bot' },
            createdAt: '2026-07-05T12:02:00.000Z',
            updatedAt: '2026-07-05T12:02:00.000Z',
            isBotAuthored: true,
          },
          {
            id: 'c-3',
            body: 'Fresh human request',
            author: { login: 'bob' },
            createdAt: '2026-07-05T12:03:00.000Z',
            updatedAt: '2026-07-05T12:03:00.000Z',
            isBotAuthored: false,
          },
        ],
        wake: {
          stage: 'implement',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:03:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: { lastHandledCommentId: 'c-2' },
      },
    });

    expect(result.prompt).toContain('<wake-comments-to-address>');
    expect(result.prompt).toContain('New human comments since the last handled Wake run');
    expect(result.prompt).toContain('Fresh human request');
    expect(result.prompt).toContain('<wake-comment-history>');
    expect(result.prompt).toContain('Earlier human context');
    expect(result.prompt).toContain('Wake status update');
  });

  it('assembles a refine-stage prompt that withholds edit tools', async () => {
    const result = await buildStagePrompt({
      action: 'refine',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#13',
        issue: {
          repo: 'atolis-hq/wake',
          number: 13,
          title: 'Example issue',
          body: 'Please add a widget.',
          labels: [],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/13',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'queue',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
      },
    });

    expect(result.prompt).toContain('REFINE stage');
    expect(result.prompt).toContain('Your only available tools are: Read, Glob, Grep');
    expect(result.prompt).toContain('Do not attempt to use Edit, Write, or any Bash');
    expect(result.prompt).toContain('<wake-untrusted-data>');
    expect(result.prompt).toContain('Please add a widget.');
    expect(result.prompt).not.toContain('gh pr create');
    expect(result.permissionMode).toBe('default');
    expect(result.allowedTools).toContain('Read');
    expect(result.allowedTools).toContain('Glob');
    expect(result.allowedTools).toContain('Grep');
    expect(result.allowedTools).toContain('Bash(git status)');
    expect(result.allowedTools).not.toContain('Edit');
  });

  it('assembles a stage prompt from an explicit prompts root when configured', async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), 'wake-prompts-'));
    await writeFile(
      join(promptsDir, 'refine.start.md'),
      [
        '---',
        'permissionMode: default',
        'allowedTools: Read',
        'maxTurns: 10',
        '---',
        'Custom template for {{workItemKey}}',
      ].join('\n'),
      'utf8',
    );

    const result = await buildStagePrompt({
      action: 'refine',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#14',
        issue: {
          repo: 'atolis-hq/wake',
          number: 14,
          title: 'Example issue',
          body: 'Please add a widget.',
          labels: [],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/14',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'queue',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
      },
      config: {
        ...createDefaultWakeConfig('/tmp/wake'),
        paths: { wakeRoot: '/tmp/wake', promptsRoot: promptsDir },
      },
    });

    expect(result.prompt).toContain('Custom template for atolis-hq/wake#14');
    expect(result.allowedTools).toEqual(['Read']);
  });

  it('includes extraArgs verbatim before the -- terminator', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: 'do work',
      sessionName: 'Eddy',
      extraArgs: ['--dangerously-skip-permissions'],
    });

    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--');
    expect(args.at(-1)).toBe('do work');
  });

  it('includes allowedTools and permission-mode flags in a print invocation when requested', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: 'do work',
      systemPrompt: 'Wake harness',
      sessionName: 'Eddy',
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash(git *)', 'Bash(gh *)'],
    });

    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('Wake harness');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Bash(git *) Bash(gh *)');
    expect(args).toContain('--');
    expect(args.at(-1)).toBe('do work');
  });

  it('includes a --remote-control flag with the given name and still terminates before the prompt', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: 'do work',
      sessionName: 'Eddy',
      remoteControlName: 'Eddy-issue-8-run-1',
    });

    expect(args).toContain('--remote-control');
    expect(args).toContain('Eddy-issue-8-run-1');
    expect(args).toContain('--');
    expect(args.at(-1)).toBe('do work');
  });

  it('builds a session name from the ticket id, title, and run id', () => {
    const name = buildEddySessionName({
      sessionName: 'Eddy',
      issueNumber: 8,
      title: 'Update README with runner config documentation',
      runId: 'run-8-1783282434129',
    });

    expect(name).toBe(
      'Eddy-issue-8-update-readme-with-runner-config-documen-run-8-1783282434129',
    );
  });

  it('formats a run correlation log line with run and recent event ids', () => {
    const line = formatClaudeRunLogLine({
      phase: 'start',
      runId: 'run-12-1',
      action: 'implement',
      issueNumber: 12,
      repo: 'atolis-hq/wake',
      recentEventIds: ['evt-1', 'evt-2'],
      model: 'claude-sonnet-5',
      workspacePath: '/wake/workspaces/atolis-hq__wake/12',
    });

    expect(line).toContain('[claude-run]');
    expect(line).toContain('phase=start');
    expect(line).toContain('cli=Claude');
    expect(line).toContain('model=claude-sonnet-5');
    expect(line).toContain('runId=run-12-1');
    expect(line).toContain('repo=atolis-hq/wake');
    expect(line).toContain('issueNumber=12');
    expect(line).toContain('action=implement');
    expect(line).toContain('recentEventIds=evt-1,evt-2');
    expect(line).toContain('workspacePath=/wake/workspaces/atolis-hq__wake/12');
  });

  it('includes --resume <sessionId> before the -- terminator when resumeSessionId is provided', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: 'do work',
      sessionName: 'Eddy',
      resumeSessionId: 'session-abc-123',
    });

    const resumeIdx = args.indexOf('--resume');
    const dashDashIdx = args.indexOf('--');
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(args[resumeIdx + 1]).toBe('session-abc-123');
    expect(resumeIdx).toBeLessThan(dashDashIdx);
    expect(args.at(-1)).toBe('do work');
  });

  it('omits --resume when no resumeSessionId is provided', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: 'do work',
      sessionName: 'Eddy',
    });

    expect(args).not.toContain('--resume');
  });

  it('includes a --max-turns flag when maxTurns is provided', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: 'do work',
      sessionName: 'Eddy',
      maxTurns: 10,
    });

    expect(args).toContain('--max-turns');
    expect(args).toContain('10');
  });

  it('renders tool capability note into refine start prompt for Claude tool names', async () => {
    const result = await buildStagePrompt({
      action: 'refine',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#20',
        issue: {
          repo: 'atolis-hq/wake',
          number: 20,
          title: 'Example issue',
          body: 'Body',
          labels: [],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/20',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'queue',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
      },
    });

    // The default note contains Claude tool names from the frontmatter
    expect(result.prompt).toContain('Read, Glob, Grep');
    expect(result.prompt).toContain('Bash(git status)');
    // Should not have an unresolved template variable
    expect(result.prompt).not.toContain('{{toolCapabilityNote}}');
  });

  it('applies contextOverrides to replace toolCapabilityNote for non-Claude runners', async () => {
    const codexNote = 'Use shell commands: cat, ls, grep. Sandbox blocks writes.';
    const result = await buildStagePrompt({
      action: 'refine',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#20',
        issue: {
          repo: 'atolis-hq/wake',
          number: 20,
          title: 'Example issue',
          body: 'Body',
          labels: [],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/20',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'queue',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
      },
      contextOverrides: { toolCapabilityNote: codexNote },
    });

    expect(result.prompt).toContain(codexNote);
    // The Claude-specific tool names should no longer appear as the tool note
    expect(result.prompt).not.toContain('Read, Glob, Grep');
  });

  it('reads maxTurns from the real refine and implement prompt templates', async () => {
    const refine = await buildStagePrompt({
      action: 'refine',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#20',
        issue: {
          repo: 'atolis-hq/wake',
          number: 20,
          title: 'Example issue',
          body: 'Body',
          labels: [],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/20',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'queue',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
      },
    });

    expect(refine.maxTurns).toBeGreaterThan(0);
  });

  it('throws when a prompt template is missing the required maxTurns frontmatter', async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), 'wake-prompts-'));
    await writeFile(
      join(promptsDir, 'refine.start.md'),
      ['---', 'permissionMode: default', 'allowedTools: Read', '---', 'No maxTurns here'].join(
        '\n',
      ),
      'utf8',
    );

    await expect(
      buildStagePrompt({
        action: 'refine',
        projection: {
          schemaVersion: 1,
          workItemKey: 'atolis-hq/wake#21',
          issue: {
            repo: 'atolis-hq/wake',
            number: 21,
            title: 'Example issue',
            body: 'Body',
            labels: [],
            assignees: [],
            isPullRequest: false,
            state: 'open',
            url: 'https://example.test/issues/21',
            createdAt: '2026-07-05T12:00:00.000Z',
            updatedAt: '2026-07-05T12:00:00.000Z',
          },
          comments: [],
          wake: {
            stage: 'queue',
            stageHistory: [],
            recentEventIds: [],
            syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
          },
          context: {},
        },
        config: {
          ...createDefaultWakeConfig('/tmp/wake'),
          paths: { wakeRoot: '/tmp/wake', promptsRoot: promptsDir },
        },
      }),
    ).rejects.toThrow(/missing a required "maxTurns"/);
  });

  it('kills a hung invocation once the wall-clock timeout elapses and reports timedOut', async () => {
    const result = await runClaudeCommand({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: process.cwd(),
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  it('does not report a timeout for a process that finishes on its own', async () => {
    const result = await runClaudeCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it.skipIf(platform === 'win32')(
    'reports cache tokens, cost, and turn count from a successful run (#135)',
    async () => {
      const commandDir = await mkdtemp(join(tmpdir(), 'wake-claude-cli-'));
      const command = join(commandDir, 'claude-success');
      const claudeJson = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'done\nDONE',
        session_id: 'session-abc',
        total_cost_usd: 0.0247,
        num_turns: 3,
        usage: {
          input_tokens: 10,
          output_tokens: 295,
          cache_creation_input_tokens: 10860,
          cache_read_input_tokens: 15157,
        },
      });
      await writeFile(
        command,
        ['#!/usr/bin/env bash', `printf '%s' '${claudeJson}'`].join('\n'),
        'utf8',
      );
      await chmod(command, 0o755);

      const runner = createClaudeRunner({
        command,
        cwd: process.cwd(),
        settings: {
          command,
          model: 'haiku',
          models: { default: 'haiku' },
          smokeModel: 'haiku',
          sessionName: 'Eddy',
          remoteControlName: 'Eddy',
          smokePrompt: defaultSmokePrompt,
          timeoutMs: 10_000,
          remoteControl: { enabled: false },
        },
      });

      const result = await runner.run({
        action: 'implement',
        projection: baseProjection,
        recentEvents: [],
        config: createDefaultWakeConfig(process.cwd()),
        runId: 'run-12-token-usage',
      });

      expect(result.tokenUsage).toEqual({
        inputTokens: 10,
        outputTokens: 295,
        cacheCreationInputTokens: 10860,
        cacheReadInputTokens: 15157,
        costUsd: 0.0247,
        turns: 3,
      });
    },
  );

  it('classifies Claude CLI quota failures separately from infra failures', () => {
    expect(classifyClaudeCliFailure({
      stdout: '',
      stderr: 'Error: rate limit exceeded',
      timedOut: false,
    })).toBe('quota');

    expect(classifyClaudeCliFailure({
      stdout: '',
      stderr: 'spawn claude ENOENT',
      timedOut: false,
    })).toBe('infra');
  });

  it('classifies session limit (429) as quota not infra', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      result: "You've hit your session limit · resets 12:20pm (UTC)",
    });

    expect(classifyClaudeCliFailure({ stdout, stderr: '', timedOut: false })).toBe('quota');
  });

  it.skipIf(platform === 'win32')('surfaces non-JSON stdout from failed Claude invocations', async () => {
    const commandDir = await mkdtemp(join(tmpdir(), 'wake-claude-cli-'));
    const command = join(commandDir, 'claude-fails');
    await writeFile(
      command,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "Claude Code login required"',
        'printf "%s\\n" "stderr detail" >&2',
        'exit 1',
      ].join('\n'),
      'utf8',
    );
    await chmod(command, 0o755);

    const runner = createClaudeRunner({
      command,
      cwd: process.cwd(),
      settings: {
        command,
        model: 'haiku',
        models: { default: 'haiku' },
        smokeModel: 'haiku',
        sessionName: 'Eddy',
        remoteControlName: 'Eddy',
        smokePrompt: defaultSmokePrompt,
        timeoutMs: 10_000,
        remoteControl: { enabled: false },
      },
    });

    const result = await runner.run({
      action: 'implement',
      projection: baseProjection,
      recentEvents: [],
      config: createDefaultWakeConfig(process.cwd()),
      runId: 'run-12-stdout-failure',
    });

    expect(result.result).toContain('Claude runner failed');
    expect(result.result).toContain('stderr detail');
    expect(result.result).toContain('Claude Code login required');
    expect(result.metadata?.stdout).toBe('Claude Code login required\n');
  });
});

describe('model resolution', () => {
  type ClaudeSettings = {
    model: string;
    models?: { default?: string; refine?: string; implement?: string };
  };

  function resolveTestModel(settings: ClaudeSettings, action: 'implement' | 'refine'): string {
    const models = settings.models ?? {};
    return models[action] ?? models.default ?? settings.model;
  }

  it('uses action-specific model when configured', () => {
    const settings: ClaudeSettings = { model: 'haiku', models: { implement: 'sonnet-4.6' } };
    const args = buildClaudePrintArgs({
      model: resolveTestModel(settings, 'implement'),
      prompt: 'test',
      sessionName: 'Eddy',
    });
    expect(args).toContain('sonnet-4.6');
  });

  it('falls back to default model when action-specific model is not set', () => {
    const settings: ClaudeSettings = { model: 'haiku', models: { default: 'opus', implement: 'sonnet-4.6' } };
    const args = buildClaudePrintArgs({
      model: resolveTestModel(settings, 'refine'),
      prompt: 'test',
      sessionName: 'Eddy',
    });
    expect(args).toContain('opus');
  });

  it('falls back to model field when no models overrides set', () => {
    const settings: ClaudeSettings = { model: 'legacy-haiku' };
    const args = buildClaudePrintArgs({
      model: resolveTestModel(settings, 'implement'),
      prompt: 'test',
      sessionName: 'Eddy',
    });
    expect(args).toContain('legacy-haiku');
  });

  it('prioritizes models.default over model field', () => {
    const settings: ClaudeSettings = { model: 'legacy-haiku', models: { default: 'new-haiku' } };
    const args = buildClaudePrintArgs({
      model: resolveTestModel(settings, 'implement'),
      prompt: 'test',
      sessionName: 'Eddy',
    });
    expect(args).toContain('new-haiku');
  });
});
