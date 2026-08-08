import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { watchId, workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { WatchGateVerdictSignal } from '../../../src-next/orchestration/index.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-DARKFACTORY-004',
    title: "a watch child's own retry does not re-trigger its own watch",
    given: [
      "a watchGate whose watch subscribes to the generic 'execution.run-succeeded' event " +
        '(the real production trigger, not a synthetic test-only event name)',
    ],
    when: [
      "the spawned review child's own first activation fails and is retried within that " +
        'same child instance, producing a second run-succeeded event',
    ],
    then: [
      'only one child is ever requested for the watch (its own retry is not mistaken for a ' +
        'second independent trigger), the group budget is never exhausted, and the parent ' +
        "advances past the gate once the child's real verdict resolves it",
    ],
  },
  async () => {
    const world = new TestWorld();
    let reviewAttempts = 0;
    world.registerActivity({
      name: activityName('work'),
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
      name: activityName('review'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
      outcomeKinds: ['done', 'failed'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          reviewAttempts += 1;
          return reviewAttempts === 1 ? { kind: 'failed' } : { kind: 'done' };
        },
      },
    });
    world.configureWorkflow('review', {
      stages: {
        check: {
          activity: 'review',
          with: {},
          on: {
            done: { then: 'done' },
            failed: { retry: { max: 1 }, then: 'await-human' },
          },
        },
      },
    });
    world.configureWorkflow('parent', {
      stages: {
        work: {
          activity: 'work',
          with: {},
          on: { done: { then: 'done', watchGates: ['review'] } },
        },
      },
      watches: [
        {
          id: 'review',
          while: { stages: ['work'], statuses: ['waiting'] },
          on: { events: ['execution.run-succeeded'] },
          workflow: 'review',
          maxPerGroup: 1,
        },
      ],
    });

    const work = await world.createWork({ objective: 'prove watch trigger scoping' });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('parent'),
    });

    await world.advance(work.workItemId);
    await world.advance(work.workItemId);
    await world.advance(work.workItemId);

    const requests = await world.events('orchestration.child-requested');
    const budgetExhausted = await world.events('orchestration.group-budget-exhausted');
    expect(requests).toHaveLength(1);
    expect(budgetExhausted).toHaveLength(0);

    const parentView = await world.viewWorkflow(parent.workflowInstanceId);
    expect(parentView?.status).not.toBe('blocked');

    const child = (await world.orchestration.listAll()).find(
      (workflow) => workflow.parentWorkflowInstanceId === parent.workflowInstanceId,
    );
    expect(child).toBeDefined();
    await world.acceptSignal(parent.workflowInstanceId, {
      kind: WatchGateVerdictSignal,
      outcome: 'done',
      authority: { kind: 'watch', watch: watchId('review') },
      actorId: 'test',
      actorDecision: { authorized: true, evidenceId: 'review-verdict' },
      providerEventId: 'review-verdict',
    });

    const resolved = await world.viewWorkflow(parent.workflowInstanceId);
    expect(resolved?.status).toBe('completed');
    expect(reviewAttempts).toBe(2);
  },
);
