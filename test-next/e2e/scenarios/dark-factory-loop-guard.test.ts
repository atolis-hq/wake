import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import {
  signalName,
  watchId,
  workflowName,
} from '../../../src-next/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-DARKFACTORY-002',
    title: 'repeated rejections exhaust the watch budget and block the parent',
    given: ['a three-child pr-review watch gate'],
    when: ['four review triggers arrive after rejection cycles'],
    then: ['only three children are requested and the parent blocks'],
  },
  async () => {
    const world = new TestWorld();
    world.registerActivity({
      name: activityName('implement'),
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
      stages: { review: { activity: 'pr-review', with: {}, on: { done: { then: 'done' } } } },
    });
    world.configureWorkflow('dark-factory', {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done', watchGates: ['pr-review'] } },
        },
      },
      watches: [
        {
          id: 'pr-review',
          while: { stages: ['implement'], statuses: ['waiting'] },
          on: { events: ['pr-review.requested'] },
          workflow: 'pr-review',
          maxPerGroup: 3,
        },
      ],
    });
    const work = await world.createWork({ objective: 'persistent objector' });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('dark-factory'),
    });
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await world.advance(work.workItemId);
      await world.triggerWatch('pr-review.requested', `pr-${cycle}`);
      await world.acceptSignal(parent.workflowInstanceId, {
        kind: signalName('orchestration.watch-gate-verdict'),
        outcome: 'rejected',
        actorId: 'bot',
        actorDecision: { authorized: true, evidenceId: `pr-${cycle}` },
        providerEventId: `pr-${cycle}`,
        authority: { kind: 'watch', watch: watchId('pr-review') },
      });
    }
    await world.advance(work.workItemId);
    await world.triggerWatch('pr-review.requested', 'pr-4');
    expect(await world.events('orchestration.child-requested')).toHaveLength(3);
    expect(await world.events('orchestration.group-budget-exhausted')).toHaveLength(1);
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('blocked');
  },
);
