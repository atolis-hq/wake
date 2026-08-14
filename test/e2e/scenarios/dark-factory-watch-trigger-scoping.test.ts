import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { watchId, workflowName } from '../../../src/orchestration/contracts/identifiers.js';
import { WatchGateVerdictSignal } from '../../../src/orchestration/index.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-DARKFACTORY-004',
    title: "one WorkflowInstance's own wait-state transition does not re-trigger a sibling's watch",
    given: [
      "a watchGate whose watch subscribes to 'orchestration.signal-wait-started' (the real " +
        'production trigger, not a synthetic test-only event name), declared on a workflow ' +
        'shared by two independent, unrelated WorkItems',
    ],
    when: [
      'both sibling instances independently reach the same watched stage and enter waiting ' +
        'around the same time, each producing its own signal-wait-started event',
    ],
    then: [
      'each sibling gets exactly its own child requested for its own trigger — one signal-wait ' +
        '-started event never spawns a watch child for the other, unrelated instance — and both ' +
        'parents advance past the gate once their own child resolves it',
    ],
  },
  async () => {
    const world = new TestWorld();
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
        check: {
          activity: 'review',
          with: {},
          on: { done: { then: 'done' } },
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
          on: { events: ['orchestration.signal-wait-started'] },
          workflow: 'review',
          maxPerGroup: 1,
        },
      ],
    });

    const workA = await world.createWork({ objective: 'prove watch trigger scoping (a)' });
    const workB = await world.createWork({ objective: 'prove watch trigger scoping (b)' });
    const parentA = await world.startWorkflow({
      workItemId: workA.workItemId,
      workflowName: workflowName('parent'),
    });
    const parentB = await world.startWorkflow({
      workItemId: workB.workItemId,
      workflowName: workflowName('parent'),
    });

    await world.advance(workA.workItemId);
    await world.advance(workB.workItemId);
    await world.advance(workA.workItemId);
    await world.advance(workB.workItemId);

    const requests = await world.events('orchestration.child-requested');
    const budgetExhausted = await world.events('orchestration.group-budget-exhausted');
    expect(requests).toHaveLength(2);
    expect(budgetExhausted).toHaveLength(0);

    const childA = (await world.orchestration.listAll()).find(
      (workflow) => workflow.parentWorkflowInstanceId === parentA.workflowInstanceId,
    );
    const childB = (await world.orchestration.listAll()).find(
      (workflow) => workflow.parentWorkflowInstanceId === parentB.workflowInstanceId,
    );
    expect(childA).toBeDefined();
    expect(childB).toBeDefined();
    expect(childA?.workflowInstanceId).not.toBe(childB?.workflowInstanceId);

    for (const parent of [parentA, parentB]) {
      await world.acceptSignal(parent.workflowInstanceId, {
        kind: WatchGateVerdictSignal,
        outcome: 'done',
        authority: { kind: 'watch', watch: watchId('review') },
        actorId: 'test',
        actorDecision: { authorized: true, evidenceId: `${parent.workflowInstanceId}-verdict` },
        providerEventId: `${parent.workflowInstanceId}-verdict`,
      });
      const resolved = await world.viewWorkflow(parent.workflowInstanceId);
      expect(resolved?.status).toBe('completed');
    }
  },
);
