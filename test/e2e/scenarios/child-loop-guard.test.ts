import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import {
  signalName,
  watchId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  OrchestrationEventType,
  selectOrchestrationEvent,
} from '../../../src/orchestration/index.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-ORCH-LOOP-001',
    title: 'a watcher dispatches one bounded child and rejects its causal completion',
    given: ['a waiting parent and an event-triggered review watch'],
    when: ['the review completes and its completion is observed again'],
    then: ['the child is consumed once without resetting the group budget or looping'],
  },
  async () => {
    const world = new TestWorld();
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('blocked') }).strict(),
      outcomeKinds: ['blocked'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'blocked' } as const;
        },
      },
    });
    world.registerActivity({
      name: activityName('pr-review'),
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
    world.configureWorkflow('pr-review', {
      stages: {
        review: {
          activity: 'pr-review',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    });
    world.configureWorkflow('parent', {
      stages: {
        implement: { activity: 'implement', with: {}, on: { blocked: { then: 'await-human' } } },
      },
      watches: [
        {
          id: 'pr-review',
          while: { stages: ['implement'], statuses: ['active', 'waiting', 'blocked'] },
          on: { events: ['review.requested', 'orchestration.child-completed'] },
          workflow: 'pr-review',
          maxPerGroup: 1,
        },
      ],
    });
    const work = await world.createWork({ objective: 'implement with a review' });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('parent'),
    });
    await world.advanceUntilSettled(work.workItemId);
    await world.waitForSignal(parent.workflowInstanceId, {
      signalKind: signalName('orchestration.child-completed'),
      from: [{ kind: 'watch', watch: watchId('pr-review') }],
    });

    await world.triggerWatch('review.requested', 'review-1');
    await world.triggerWatch('review.requested', 'review-1');
    const requested = await world.events('orchestration.child-requested');
    expect(requested).toHaveLength(1);
    const childId = `${parent.workflowInstanceId}:watch:pr-review:trigger:review-1`;
    expect((await world.viewWorkflow(childId))?.parentWorkflowInstanceId).toBe(
      parent.workflowInstanceId,
    );

    await world.advanceUntilSettled(work.workItemId);
    const resumed = await world.viewWorkflow(parent.workflowInstanceId);
    expect(resumed?.acceptedChildCompletionIds, await world.trace()).toEqual([childId]);
    expect(resumed?.pendingActivation?.ordinal).toBe(2);
    expect(await world.events('orchestration.child-completion-consumed')).toHaveLength(1);

    await world.advanceUntilSettled(work.workItemId);
    await world.advanceUntilSettled(work.workItemId);
    expect(await world.events('orchestration.child-requested')).toHaveLength(1);

    const [childCompleted] = await world.events('orchestration.child-completed');
    if (childCompleted === undefined) throw new Error('Child completion was not recorded');
    const childCompletion = selectOrchestrationEvent(childCompleted);
    if (childCompletion?.eventType !== OrchestrationEventType.ChildCompleted)
      throw new Error('Recorded child completion was invalid');
    await world.triggerWatch(
      childCompletion.eventType,
      childId,
      {
        ...childCompletion.payload,
        causalCycleId: `${childCompletion.payload.causalCycleId}:reobserved`,
      },
      childCompletion.stream,
    );
    expect(await world.events('orchestration.child-requested')).toHaveLength(1);
    expect(await world.events('orchestration.causal-activation-rejected')).toHaveLength(1);
    expect(await world.events('orchestration.group-budget-exhausted')).toHaveLength(1);
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('blocked');
  },
);
