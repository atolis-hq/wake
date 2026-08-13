import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { signalName, workflowName } from '../../../src/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-DARKFACTORY-003',
    title: 'a watch child that never renders a verdict leaves its parent untouched',
    given: ['a parent waiting on a review, and a watch child that only ever fails technically'],
    when: ["the child's activity fails three times in a row, exhausting its own retries"],
    then: [
      'the child waits for human attention, never completing',
      'no signal is ever accepted against the parent',
      "the parent's status and pending state are untouched",
    ],
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
      outcomeSchema: z.object({ kind: z.literal('failed') }).strict(),
      outcomeKinds: ['failed'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'failed' } as const;
        },
      },
    });
    world.configureWorkflow('pr-review', {
      stages: {
        review: {
          activity: 'pr-review',
          with: {},
          on: { failed: { retry: { max: 2 }, then: 'await-human' } },
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
          while: { stages: ['implement'], statuses: ['waiting'] },
          on: { events: ['review.requested'] },
          workflow: 'pr-review',
          maxPerGroup: 2,
        },
      ],
    });
    const work = await world.createWork({ objective: 'implement with a flaky reviewer' });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('parent'),
    });
    await world.advanceUntilSettled(work.workItemId);
    await world.waitForSignal(parent.workflowInstanceId, {
      signalKind: signalName('orchestration.child-completed'),
    });
    const before = await world.viewWorkflow(parent.workflowInstanceId);
    await world.triggerWatch('review.requested', 'review-1');
    await world.advanceUntilSettled(work.workItemId);
    await world.advanceUntilSettled(work.workItemId);
    await world.advanceUntilSettled(work.workItemId);
    const childId = `${parent.workflowInstanceId}:watch:pr-review:trigger:review-1`;
    expect((await world.viewWorkflow(childId))?.status).toBe('waiting');
    expect(await world.events('orchestration.signal-accepted')).toHaveLength(0);
    const after = await world.viewWorkflow(parent.workflowInstanceId);
    expect(after).toEqual(before);
    expect(after?.status).toBe('waiting');
    expect(await world.events('orchestration.instance-blocked')).toHaveLength(0);
  },
);
