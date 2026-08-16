import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import {
  signalName,
  watchId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-ORCH-CHILD-001',
    title: 'a completed child signals its parent once without becoming primary',
    given: ['a waiting parent and a review watcher'],
    when: ['the child review completes'],
    then: ['the parent resumes from one typed child-completion signal'],
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
      name: activityName('review'),
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
    world.configureWorkflow('review', {
      stages: {
        review: {
          activity: 'review',
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
          id: 'review',
          while: { stages: ['implement'], statuses: ['waiting'] },
          on: { events: ['review.requested'] },
          workflow: 'review',
          maxPerGroup: 1,
        },
      ],
    });
    const work = await world.createWork({ objective: 'ship reviewed work' });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('parent'),
    });
    await expect(
      world.startWorkflow({
        workItemId: work.workItemId,
        workflowName: workflowName('parent'),
        workflowInstanceId: workflowInstanceId('second-primary'),
      }),
    ).rejects.toThrow(/primary workflow/);
    await world.advanceUntilSettled(work.workItemId);
    await world.waitForSignal(parent.workflowInstanceId, {
      signalKind: signalName('orchestration.child-completed'),
      from: [{ kind: 'watch', watch: watchId('review') }],
    });
    await world.triggerWatch('review.requested', 'review-request-1');
    const childId = `${parent.workflowInstanceId}:watch:review:trigger:review-request-1`;

    await world.advanceUntilSettled(work.workItemId);

    expect((await world.viewWorkflow(childId))?.status).toBe('completed');
    expect(
      (await world.viewWorkflow(parent.workflowInstanceId))?.acceptedChildCompletionIds,
    ).toEqual([childId]);
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.pendingActivation?.ordinal).toBe(
      2,
    );
    const [acceptedSignal] = await world.events('orchestration.signal-accepted');
    expect(acceptedSignal?.payload).toEqual(
      expect.objectContaining({
        kind: 'orchestration.child-completed',
        providerEventId: childId,
        childWorkflowInstanceId: childId,
      }),
    );
    expect(await world.events('orchestration.signal-accepted')).toHaveLength(1);
    const starts = await world.events('orchestration.instance-started');
    expect(
      starts.filter(
        (event) =>
          (event.payload as { parentWorkflowInstanceId?: string }).parentWorkflowInstanceId ===
          undefined,
      ),
    ).toHaveLength(1);
    expect(await world.events('orchestration.child-completion-consumed')).toHaveLength(1);
  },
);
