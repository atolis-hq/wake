import { describe, expect, it } from 'vitest';

import {
  buildStagePrompt,
  buildClaudePrintArgs,
  buildClaudeRemoteControlArgs,
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

  it('assembles a stage prompt from a projection summary and recent events', () => {
    const prompt = buildStagePrompt({
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

    expect(prompt).toContain('Projection summary');
    expect(prompt).toContain('atolis-hq/wake#12');
    expect(prompt).toContain('github.issue.comment.created');
  });
});
