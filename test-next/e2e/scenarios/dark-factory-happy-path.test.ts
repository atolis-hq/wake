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
    title: 'a rejected watch verdict re-runs implement and a done verdict completes it',
    given: ['implement gated by pr-review'],
    when: ['a watch rejects then approves'],
    then: ['implement runs twice and completes after approval'],
  },
  async () => {
    const world = new TestWorld();
    let attempts = 0;
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          attempts += 1;
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
    await world.acceptSignal(parent.workflowInstanceId, {
      kind: WatchGateVerdictSignal,
      outcome: 'rejected',
      actorId: 'bot',
      actorDecision: { authorized: true, evidenceId: 'reject' },
      providerEventId: 'reject',
      authority: { kind: 'watch', watch: watchId('pr-review') },
    });
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.pendingActivation?.ordinal).toBe(
      2,
    );
    await world.advance(work.workItemId);
    await world.acceptSignal(parent.workflowInstanceId, {
      kind: WatchGateVerdictSignal,
      outcome: 'done',
      actorId: 'bot',
      actorDecision: { authorized: true, evidenceId: 'approve' },
      providerEventId: 'approve',
      authority: { kind: 'watch', watch: watchId('pr-review') },
    });
    expect(attempts).toBe(2);
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('completed');
  },
);
