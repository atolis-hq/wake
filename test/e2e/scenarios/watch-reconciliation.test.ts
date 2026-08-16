import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { signalName, watchId } from '../../../src/orchestration/index.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-ORCH-WATCH-RECOVERY-001',
    title: 'recovers a watch trigger skipped by its reactor checkpoint',
    given: ['a parent waiting under a watch authority and an already-checkpointed matching fact'],
    when: ['ordinary advancement runs after restart'],
    then: ['the existing watch dispatch creates exactly one child request'],
  },
  async () => {
    const world = new TestWorld();
    world.registerActivity(activity('parent-work', 'blocked'));
    world.registerActivity(activity('review-work', 'done'));
    world.configureWorkflow('review', {
      stages: {
        review: {
          activity: 'review-work',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    });
    world.configureWorkflow('parent', {
      stages: {
        work: { activity: 'parent-work', with: {}, on: { blocked: { then: 'await-human' } } },
      },
      watches: [
        {
          id: 'review',
          while: { stages: ['work'], statuses: ['waiting'] },
          on: { events: ['review.requested'] },
          workflow: 'review',
          maxPerGroup: 1,
        },
      ],
    });
    const work = await world.createWork({ objective: 'recover the watcher' });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: 'parent',
    });
    await world.advanceUntilSettled(work.workItemId);
    await world.waitForSignal(parent.workflowInstanceId, {
      signalKind: signalName('orchestration.child-completed'),
      from: [{ kind: 'watch', watch: watchId('review') }],
    });
    const trigger = await world.appendFact('review.requested', {}, 'orphaned-trigger');
    await world.checkpoints.save('reactor:orchestration.watch', trigger.globalPosition);

    await world.advance(work.workItemId);
    await world.checkpoints.reset('reconciler:orchestration.watch');
    await world.advance(work.workItemId);

    expect(await world.events('orchestration.child-requested')).toHaveLength(1);
    expect(await world.events('orchestration.group-claimed')).toHaveLength(1);
  },
);

function activity(name: string, outcome: 'blocked' | 'done') {
  return {
    name: activityName(name),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal(outcome) }).strict(),
    outcomeKinds: [outcome],
    resources: [],
    executionKind: 'deterministic' as const,
    handler: {
      async execute() {
        return { kind: outcome };
      },
    },
  };
}
