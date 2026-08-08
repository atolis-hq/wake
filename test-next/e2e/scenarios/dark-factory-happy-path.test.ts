import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import {
  watchId,
  workflowName,
} from '../../../src-next/orchestration/contracts/identifiers.js';
import { WatchGateVerdictSignal } from '../../../src-next/orchestration/index.js';
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
    let implementAttempts = 0;
    let prReviewAttempts = 0;
    world.registerActivity({
      name: activityName('refine'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: { async execute() { return { kind: 'done' } as const; } },
    });
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          implementAttempts += 1;
          return { kind: 'done' } as const;
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
      stages: { review: { activity: 'pr-review', with: {}, on: { done: { then: 'done' }, rejected: { then: 'done' } } } },
    });
    world.configureWorkflow('plan-review', {
      stages: { review: { activity: 'refine', with: {}, on: { done: { then: 'done' } } } },
    });
    world.configureWorkflow('dark-factory', {
      stages: {
        refine: { activity: 'refine', with: {}, on: { done: { then: 'implement', watchGates: ['plan-review'] } } },
        implement: {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done', watchGates: ['pr-review'] } },
        },
      },
      watches: [
        { id: 'plan-review', while: { stages: ['refine'], statuses: ['waiting'] }, on: { events: ['plan-review.requested'] }, workflow: 'plan-review', maxPerGroup: 1 },
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
    await world.advance(work.workItemId);
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
    expect(requests.filter((event) => (event.payload as { watchId: string }).watchId === 'plan-review')).toHaveLength(1);
    expect(requests.filter((event) => (event.payload as { watchId: string }).watchId === 'pr-review')).toHaveLength(2);
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('completed');
  },
);
