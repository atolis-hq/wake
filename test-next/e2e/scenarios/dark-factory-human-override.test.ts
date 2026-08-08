import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { WatchGateVerdictSignal } from '../../../src-next/orchestration/index.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-DARKFACTORY-004',
    title: "a human's own decision always overrides a watchGate",
    given: ['implement gated by pr-review'],
    when: ['a human accepts done'],
    then: ['the workflow completes without a child'],
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
          maxPerGroup: 1,
        },
      ],
    });
    const work = await world.createWork({ objective: 'human override' });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('dark-factory'),
    });
    await world.advance(work.workItemId);
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.waitingFor?.signalKind).toBe(
      WatchGateVerdictSignal,
    );
    await world.acceptSignal(parent.workflowInstanceId, {
      kind: WatchGateVerdictSignal,
      outcome: 'done',
      actorId: 'human',
      actorDecision: { authorized: true, evidenceId: 'comment-1' },
      providerEventId: 'comment-1',
    });
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('completed');
    expect(await world.events('orchestration.child-requested')).toHaveLength(0);
  },
);
