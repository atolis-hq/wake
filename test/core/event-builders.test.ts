import { describe, expect, it } from 'vitest';

import { createLabelsEvent, createPublishIntentEvent } from '../../src/core/event-builders.js';
import type { AgentRunResult } from '../../src/core/contracts.js';
import { parseRunnerResult } from '../../src/domain/schema.js';
import type { IssueStateRecord } from '../../src/domain/types.js';

type LatestComment = {
  id: string;
  isBotAuthored: boolean;
  resourceUri?: string;
};

function projection(overrides: {
  latestComment?: LatestComment;
  lastHandledCommentId?: string;
  stage?: string;
}): IssueStateRecord {
  return {
    workItemKey: 'work-01JZ0000000000000000000001',
    issue: { repo: 'atolis-hq/wake', number: 7 },
    origin: 'github',
    wake: { stage: overrides.stage ?? 'implement' },
    context:
      overrides.lastHandledCommentId === undefined
        ? {}
        : { lastHandledCommentId: overrides.lastHandledCommentId },
    ...(overrides.latestComment === undefined ? {} : { latestComment: overrides.latestComment }),
  } as unknown as IssueStateRecord;
}

const runnerResult: AgentRunResult = {
  result: 'summary body\nDONE',
  model: 'claude-haiku',
  cli: 'claude',
  tokenUsage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 8000,
    costUsd: 0.5,
  },
};

function publishIntent(overrides: {
  sentinel: 'DONE' | 'BLOCKED' | 'FAILED' | 'AWAITING_APPROVAL';
  proj?: IssueStateRecord;
}) {
  return createPublishIntentEvent({
    projection: overrides.proj ?? projection({}),
    runId: 'run-7-1',
    action: 'implement',
    runnerResult,
    parsedRunnerResult: parseRunnerResult(runnerResult.result),
    sentinel: overrides.sentinel,
    occurredAt: '2026-07-05T12:01:00.000Z',
    startedAt: '2026-07-05T12:00:00.000Z',
  });
}

describe('createPublishIntentEvent', () => {
  it('maps each sentinel to its card kind', () => {
    expect(publishIntent({ sentinel: 'DONE' }).payload.kind).toBe('status-update');
    expect(publishIntent({ sentinel: 'BLOCKED' }).payload.kind).toBe('question');
    expect(publishIntent({ sentinel: 'AWAITING_APPROVAL' }).payload.kind).toBe('approval-request');
    expect(publishIntent({ sentinel: 'FAILED' }).payload.kind).toBe('failure');
  });

  it('hints the done stage only when the run is DONE', () => {
    expect(publishIntent({ sentinel: 'DONE' }).derivedHints?.stage).toBe('done');
    expect(publishIntent({ sentinel: 'BLOCKED' }).derivedHints?.stage).toBe('implement');
  });

  it('formats duration, tokens and cost into the payload', () => {
    const event = publishIntent({ sentinel: 'DONE' });
    expect(event.payload.duration).toBe('1m0s');
    expect(event.payload.tokens).toBe('8k');
    expect(event.payload.cost).toBe('$0.5000');
  });

  it('threads a fresh human comment surface as the reply resourceUri', () => {
    const event = publishIntent({
      sentinel: 'DONE',
      proj: projection({
        latestComment: {
          id: 'c-2',
          isBotAuthored: false,
          resourceUri: 'github:pr:atolis-hq/wake#9',
        },
        lastHandledCommentId: 'c-1',
      }),
    });
    expect(event.sourceRefs.resourceUri).toBe('github:pr:atolis-hq/wake#9');
  });

  it('does not thread a review-thread surface (milestone cards are not inline replies)', () => {
    const event = publishIntent({
      sentinel: 'DONE',
      proj: projection({
        latestComment: {
          id: 'c-2',
          isBotAuthored: false,
          resourceUri: 'github:pr-review-thread:atolis-hq/wake#9:1',
        },
        lastHandledCommentId: 'c-1',
      }),
    });
    expect(event.sourceRefs.resourceUri).toBeUndefined();
  });

  it('does not thread a stale (already-handled) comment surface', () => {
    const event = publishIntent({
      sentinel: 'DONE',
      proj: projection({
        latestComment: {
          id: 'c-1',
          isBotAuthored: false,
          resourceUri: 'github:pr:atolis-hq/wake#9',
        },
        lastHandledCommentId: 'c-1',
      }),
    });
    expect(event.sourceRefs.resourceUri).toBeUndefined();
  });
});

describe('createLabelsEvent', () => {
  it('shapes a labels-requested event with a slugged id and the label payload', () => {
    const event = createLabelsEvent({
      projection: projection({}),
      runId: 'run-7-1',
      statusLabel: 'wake:status.pending',
      stageLabel: 'wake:stage.implement',
      workflowLabel: 'wake:workflow.default',
      occurredAt: '2026-07-05T12:01:00.000Z',
    });

    expect(event.sourceEventType).toBe('wake.labels.requested');
    expect(event.payload).toMatchObject({
      statusLabel: 'wake:status.pending',
      stageLabel: 'wake:stage.implement',
      workflowLabel: 'wake:workflow.default',
      origin: 'github',
    });
    expect(event.eventId.startsWith('run-7-1-labels-')).toBe(true);
  });
});
