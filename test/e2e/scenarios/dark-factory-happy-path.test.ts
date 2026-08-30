import { expect } from 'vitest';
import { z } from 'zod';
import { activityName, createAgentActivity } from '../../../src/activities/index.js';
import { createCommentHistoryReader } from '../../../src/integrations/github/application/comment-history-reader.js';
import {
  BuiltInAdapterId,
  DeliveryEventType,
  DeliveryIntentEventType,
  deliveryStream,
} from '../../../src/integrations/github/index.js';
import { correlationId, createEventData, eventId } from '../../../src/kernel/index.js';
import { watchId, workflowName } from '../../../src/orchestration/contracts/identifiers.js';
import { WatchGateVerdictSignal } from '../../../src/orchestration/index.js';
import { resourceKind, resourceStream, type ResourceId } from '../../../src/resources/index.js';
import type { WorkItemId } from '../../../src/work/index.js';
import { resId } from '../../support/identities.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-DARKFACTORY-001',
    title: 'real review-watch children gate refine and implement',
    given: ['refine gated by plan-review and implement gated by pr-review'],
    when: ['plan-review approves; pr-review rejects once then approves'],
    then: ['one plan-review and two pr-review children are requested within their budgets'],
  },
  async () => {
    const world = new TestWorld();
    const implementPrompts: string[] = [];
    const commentHistory = createCommentHistoryReader(world.journal, world.resources, {
      publicUiUrl: 'https://wake.example.test',
    });
    const implementAgent = createAgentActivity(
      {
        async render() {
          return { prompt: 'Implement the requested changes.' };
        },
      },
      {
        async forWorkItem(workItemId) {
          return {
            title: '',
            body: '',
            comments: await commentHistory.forWorkItem(workItemId as WorkItemId),
          };
        },
      },
    );
    let implementAttempts = 0;
    let prReviewAttempts = 0;
    world.registerActivity({
      name: activityName('refine'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'done' } as const;
        },
      },
    });
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({ template: z.literal('implement') }).strict(),
      outcomeSchema: z
        .object({
          kind: z.literal('done'),
          data: z.object({ status: z.literal('DONE') }).passthrough(),
        })
        .strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute(invocation, context) {
          implementAttempts += 1;
          return implementAgent.execute(
            invocation as Parameters<typeof implementAgent.execute>[0],
            {
              ...context,
              runner: {
                async start(request) {
                  implementPrompts.push(request.prompt);
                  return {
                    result: Promise.resolve({
                      transport: 'succeeded' as const,
                      output: JSON.stringify({ status: 'DONE' }),
                    }),
                  };
                },
              },
            },
          );
        },
      },
    });
    world.registerActivity({
      name: activityName('pr-review'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.enum(['done', 'rejected']) }).strict(),
      outcomeKinds: ['done', 'rejected'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          prReviewAttempts += 1;
          return prReviewAttempts === 1 ? { kind: 'rejected' } : { kind: 'done' };
        },
      },
    });
    world.configureWorkflow('pr-review', {
      stages: {
        review: {
          activity: 'pr-review',
          with: {},
          on: { done: { then: 'done' }, rejected: { then: 'done' } },
        },
      },
    });
    world.configureWorkflow('plan-review', {
      stages: { review: { activity: 'refine', with: {}, on: { done: { then: 'done' } } } },
    });
    world.configureWorkflow('dark-factory', {
      stages: {
        refine: {
          activity: 'refine',
          with: {},
          on: { done: { then: 'implement', watchGates: ['plan-review'] } },
        },
        implement: {
          activity: 'implement',
          with: { template: 'implement' },
          on: { done: { then: 'done', watchGates: ['pr-review'] } },
        },
      },
      watches: [
        {
          id: 'plan-review',
          while: { stages: ['refine'], statuses: ['waiting'] },
          on: { events: ['plan-review.requested'] },
          workflow: 'plan-review',
          maxPerGroup: 1,
        },
        {
          id: 'pr-review',
          while: { stages: ['implement'], statuses: ['waiting'] },
          on: { events: ['pr-review.requested'] },
          workflow: 'pr-review',
          maxPerGroup: 2,
        },
      ],
    });
    const work = await world.createWork({ objective: 'review loop' });
    const resource = await world.discoverResource({
      resourceId: resId('dark-factory-issue'),
      kind: resourceKind('issue'),
      externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'owner/repo#7' },
      capabilities: [],
    });
    await world.resources.correlate(resource.resourceId, work.workItemId, 'primary', {
      commandId: 'correlate-dark-factory-issue',
      correlationId: correlationId('dark-factory'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'operator', id: 'owner' },
    });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('dark-factory'),
    });
    await world.advance(work.workItemId);
    await world.triggerWatch('plan-review.requested', 'plan-1');
    await world.advance(work.workItemId);
    await world.acceptSignal(parent.workflowInstanceId, {
      kind: WatchGateVerdictSignal,
      outcome: 'done',
      actorId: 'plan-review-bot',
      actorDecision: { authorized: true, evidenceId: 'plan-1' },
      providerEventId: 'plan-1',
      authority: { kind: 'watch', watch: watchId('plan-review') },
    });
    await world.advance(work.workItemId);
    await world.triggerWatch('pr-review.requested', 'pr-1');
    await world.advance(work.workItemId);
    await world.acceptSignal(parent.workflowInstanceId, {
      kind: WatchGateVerdictSignal,
      outcome: 'rejected',
      actorId: 'bot',
      actorDecision: { authorized: true, evidenceId: 'reject' },
      providerEventId: 'reject',
      authority: { kind: 'watch', watch: watchId('pr-review') },
    });
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.pendingActivation?.ordinal).toBe(
      3,
    );
    const rejectionDisplayBody = 'Please handle the failed error path before retrying.';
    await appendConfirmedAgentRunComment(world, resource.resourceId, rejectionDisplayBody);
    await world.advance(work.workItemId);
    expect(implementPrompts).toHaveLength(2);
    expect(implementPrompts[1]).toContain(rejectionDisplayBody);
    expect(implementPrompts[1]).toContain('**[Wake](https://wake.example.test)**');
    await world.triggerWatch('pr-review.requested', 'pr-2');
    await world.advance(work.workItemId);
    await world.acceptSignal(parent.workflowInstanceId, {
      kind: WatchGateVerdictSignal,
      outcome: 'done',
      actorId: 'bot',
      actorDecision: { authorized: true, evidenceId: 'approve' },
      providerEventId: 'approve',
      authority: { kind: 'watch', watch: watchId('pr-review') },
    });
    expect(implementAttempts).toBe(2);
    const requests = await world.events('orchestration.child-requested');
    expect(
      requests.filter((event) => (event.payload as { watchId: string }).watchId === 'plan-review'),
    ).toHaveLength(1);
    expect(
      requests.filter((event) => (event.payload as { watchId: string }).watchId === 'pr-review'),
    ).toHaveLength(2);
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('completed');
  },
);

async function appendConfirmedAgentRunComment(
  world: TestWorld,
  resourceId: ResourceId,
  displayBody: string,
): Promise<void> {
  const intentId = 'agent-run-publish-rejection';
  const intent = createEventData({
    eventId: intentId,
    eventType: DeliveryIntentEventType.AgentRunPublishRequested,
    occurredAt: world.clock.now().toISOString(),
    correlationId: 'github:owner/repo#7',
    causationId: intentId,
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream: resourceStream(resourceId),
    payload: {
      workflowInstanceId: 'workflow-1',
      activationId: 'activation-1',
      resourceId,
      report: {
        runId: 'run-rejection',
        startedAt: world.clock.now().toISOString(),
        finishedAt: world.clock.now().toISOString(),
        displayBody,
        outcome: 'REJECTED',
        metadata: {},
      },
    },
  });
  const stream = resourceStream(resourceId);
  const [published] = await world.journal.append(
    stream,
    (await world.journal.readStream(stream)).length,
    [intent],
  );
  if (published === undefined) throw new Error('Expected agent-run publication intent');
  const confirmation = createEventData({
    eventId: `${intentId}-confirmed`,
    eventType: DeliveryEventType.Confirmed,
    occurredAt: world.clock.now().toISOString(),
    correlationId: 'github:owner/repo#7',
    causationId: intentId,
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream: deliveryStream(eventId(intentId)),
    payload: {
      intentEventId: eventId(intentId),
      intentGlobalPosition: published.globalPosition,
      workflowInstanceId: 'workflow-1',
      activationId: 'activation-1',
      occurrenceOrdinal: 1,
      externalId: 'github-comment-rejection',
    },
  });
  await world.journal.append(confirmation.stream, 0, [confirmation]);
}
