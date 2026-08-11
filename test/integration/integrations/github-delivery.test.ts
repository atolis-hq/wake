import { describe, expect, it } from 'vitest';
import { MergeMethod } from '../../../src/activities/index.js';
import { translateGitHubOutbound } from '../../../src/integrations/github/application/outbound-translator.js';
import {
  BuiltInAdapterId,
  DeliveryIntentKind,
  DeliveryResultKind,
  DeliveryState,
} from '../../../src/integrations/github/index.js';
import { createGitHubDelivery } from '../../../src/integrations/github/infrastructure/delivery.js';
import { eventId } from '../../../src/kernel/index.js';
import { BuiltInResourceKind } from '../../../src/resources/index.js';
import { resId } from '../../support/identities.js';

const mergeIntent = {
  intentEventId: eventId('intent'),
  globalPosition: 1,
  workflowInstanceId: 'workflow-1',
  activationId: 'activation-1',
  kind: DeliveryIntentKind.PrMerge,
  resourceId: resId('1'),
  payload: {
    kind: DeliveryIntentKind.PrMerge,
    revision: 'abc',
    method: MergeMethod.Squash,
  },
  state: DeliveryState.Pending,
  attempts: 0,
  occurrenceOrdinal: 0,
} as const;

describe('GitHub outbound delivery', () => {
  it('translates a provider-neutral merge without evaluating policy', () => {
    expect(
      translateGitHubOutbound(
        {
          resourceId: resId('1'),
          kind: BuiltInResourceKind.PullRequest,
          externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'o/r#2' },
          capabilities: [],
        },
        mergeIntent,
      ),
    ).toMatchObject({ idempotencyKey: 'intent', merge_method: MergeMethod.Squash });
  });

  it('translates an auto-merge intent to the provider-native auto-merge action', () => {
    expect(
      translateGitHubOutbound(
        {
          resourceId: resId('1'),
          kind: BuiltInResourceKind.PullRequest,
          externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'o/r#2' },
          capabilities: [],
        },
        {
          ...mergeIntent,
          payload: { ...mergeIntent.payload, autoMerge: true },
        },
      ),
    ).toMatchObject({ action: 'enable-auto-merge', merge_method: MergeMethod.Squash });
  });

  it('rejects a pull request number outside JavaScript safe integer bounds', () => {
    expect(() =>
      translateGitHubOutbound(
        {
          resourceId: resId('1'),
          kind: BuiltInResourceKind.PullRequest,
          externalKey: {
            adapter: BuiltInAdapterId.GitHub,
            key: 'o/r#9007199254740992',
          },
          capabilities: [],
        },
        mergeIntent,
      ),
    ).toThrow(/safe integer/i);
  });

  it('targets status publication at an observed issue rather than assuming a pull request', () => {
    expect(
      translateGitHubOutbound(
        {
          resourceId: resId('2'),
          kind: BuiltInResourceKind.Issue,
          externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'o/r#3' },
          capabilities: [],
        },
        {
          ...mergeIntent,
          resourceId: resId('2'),
          kind: DeliveryIntentKind.StatusPublish,
          payload: { kind: DeliveryIntentKind.StatusPublish, body: 'Working' },
        },
      ),
    ).toMatchObject({ issue_number: 3, action: 'status' });
  });

  it('translates an agent-run publication into a GitHub reply', () => {
    expect(
      translateGitHubOutbound(
        {
          resourceId: resId('2'),
          kind: BuiltInResourceKind.Issue,
          externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'o/r#3' },
          capabilities: [],
        },
        {
          ...mergeIntent,
          resourceId: resId('2'),
          kind: DeliveryIntentKind.AgentRunPublish,
          payload: {
            kind: DeliveryIntentKind.AgentRunPublish,
            report: {
              runId: 'run-1',
              startedAt: '2026-08-03T12:00:00.000Z',
              finishedAt: '2026-08-03T12:00:01.000Z',
              displayBody: 'terminal report',
              outcome: 'FAILED',
              metadata: {},
            },
          },
        },
      ),
    ).toMatchObject({
      issue_number: 3,
      action: 'reply',
      body: expect.stringContaining('terminal report'),
    });
  });
  it('reports a stable message for a non-Error provider rejection', async () => {
    const adapter = createGitHubDelivery(async () => {
      throw { provider: 'github' };
    });

    await expect(adapter.deliver(mergeIntent, new AbortController().signal)).resolves.toEqual({
      kind: DeliveryResultKind.Failed,
      code: 'github-error',
      message: 'GitHub delivery failed with a non-Error rejection',
    });
  });
});

describe('GitHub agent-run comments', () => {
  it('formats a terminal agent result with durable Wake markers, outcome, and resume footer', async () => {
    const { formatAgentRunComment } =
      await import('../../../src/integrations/github/application/agent-run-comment.js');
    expect(
      formatAgentRunComment({
        idempotencyKey: 'run-1',
        stage: 'implement',
        runner: 'codex',
        runnerPool: 'standard',
        cli: 'codex',
        model: 'gpt-5',
        startedAt: '2026-08-03T12:00:00.000Z',
        finishedAt: '2026-08-03T12:01:30.000Z',
        runId: 'run-1',
        displayBody: 'Implemented the requested change.',
        outcome: 'DONE',
        sessionId: 'session-1',
        workspacePath: '/workspace',
        metadata: { inputTokens: 10, outputTokens: 20, costUsd: 0.03 },
        awaitingApproval: true,
      }),
    ).toContain('<!-- wake:delivery:run-1 -->');
    const awaitingApproval = formatAgentRunComment({
      idempotencyKey: 'run-1',
      displayBody: 'Plan complete.',
      outcome: 'DONE',
      metadata: {},
      awaitingApproval: true,
    });
    expect(awaitingApproval).toContain('reply with /approved');
    expect(awaitingApproval).toContain('**Outcome:** ⏳ Awaiting approval');
    expect(
      formatAgentRunComment({
        idempotencyKey: 'run-1',
        displayBody: 'Blocked on approval.',
        outcome: 'BLOCKED',
        metadata: {},
      }),
    ).toContain('Blocked');
  });
});
