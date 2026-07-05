import { describe, expect, it } from 'vitest';

import {
  buildStagePrompt,
  buildClaudePrintArgs,
  buildClaudeRemoteControlArgs,
  buildEddySessionName,
} from '../../src/adapters/claude/claude-runner.js';
import { defaultSmokePrompt } from '../../src/config/defaults.js';

describe('claude runner command building', () => {
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

  it('assembles a stage prompt from a projection summary and recent events', async () => {
    const prompt = await buildStagePrompt({
      action: 'implement',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#12',
        issue: {
          repo: 'atolis-hq/wake',
          number: 12,
          title: 'Example issue',
          body: 'Body',
          labels: ['wake:refined'],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/12',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        latestComment: {
          id: 'c-2',
          body: 'Please proceed',
          author: { login: 'shared-user' },
          createdAt: '2026-07-05T12:01:00.000Z',
          updatedAt: '2026-07-05T12:01:00.000Z',
          isWakeAuthored: false,
        },
        wake: {
          stage: 'refined',
          attempts: 1,
          stageHistory: [],
          recentEventIds: ['evt-1'],
          syncedAt: '2026-07-05T12:01:00.000Z',
        },
        context: {},
      },
      recentEvents: [
        {
          schemaVersion: 1,
          eventId: 'evt-1',
          workItemKey: 'atolis-hq/wake#12',
          streamScope: 'work-item',
          direction: 'inbound',
          sourceSystem: 'github',
          sourceEventType: 'github.issue.comment.created',
          sourceRefs: {
            repo: 'atolis-hq/wake',
            issueNumber: 12,
            commentId: 'c-2',
          },
          occurredAt: '2026-07-05T12:01:00.000Z',
          ingestedAt: '2026-07-05T12:01:01.000Z',
          trigger: 'context-only',
          payload: {
            body: 'Please proceed',
          },
        },
      ],
    });

    expect(prompt).toContain('IMPLEMENT stage');
    expect(prompt).toContain('atolis-hq/wake#12');
    expect(prompt).toContain('"github.issue.comment.created"');
    expect(prompt).toContain('wake/issue-12');
    expect(prompt).toContain('git push -u origin wake/issue-12');
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('Closes #12');
  });

  it('assembles a refine-stage prompt that withholds edit tools', async () => {
    const prompt = await buildStagePrompt({
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
          state: 'open',
          url: 'https://example.test/issues/13',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'queue',
          attempts: 0,
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
        },
        context: {},
      },
      recentEvents: [],
    });

    expect(prompt).toContain('REFINE stage');
    expect(prompt).toContain('NO Edit, Write, or Bash tool access');
    expect(prompt).toContain('Please add a widget.');
    expect(prompt).not.toContain('gh pr create');
  });

  it('includes allowedTools and permission-mode flags in a print invocation when requested', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: 'do work',
      sessionName: 'Eddy',
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash(git *)', 'Bash(gh *)'],
    });

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
});
