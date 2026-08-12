import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { createAdvanceOnce } from '../../../src/control-plane/index.js';
import { type RunView } from '../../../src/execution/index.js';
import {
  type ActivityActivationView,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
import { workflowName } from '../../../src/orchestration/contracts/identifiers.js';
import { TestWorld } from '../../e2e/support/world.js';

async function world() {
  const result = new TestWorld();
  result.registerActivity({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' };
      },
    },
  });
  result.configureWorkflow('default', {
    stages: {
      implement: {
        activity: 'implement',
        with: {},
        on: { done: { then: 'done' } },
        requiresApproval: false,
      },
    },
  });
  return result;
}

describe('advanceOnce', () => {
  it('does not reconcile after maintenance acquires during active-Run recovery', async () => {
    let paused = false;
    let reconciled = false;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => {
          reconciled = true;
        },
        listPendingActivations: async () => [],
        listWaiting: async () => [],
        acceptOutcome: async () => {
          throw new Error('No outcome should be accepted during maintenance');
        },
        markActivationStarted: async () => {
          throw new Error('No activation should start during maintenance');
        },
      },
      {
        recoverActive: async () => {
          paused = true;
          return [];
        },
        attempt: async () => {
          throw new Error('No execution attempt should begin during maintenance');
        },
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      {
        ids: { next: () => 'command-00000000000000000000000001' } as never,
        isDispatchPaused: async () => paused,
      },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
    expect(reconciled).toBe(false);
  });

  it('does not accept a completed Run outcome after maintenance acquires during lookup', async () => {
    let paused = false;
    let accepted = false;
    const activation = {
      activationId: 'activation-00000000000000000000000001',
    } as unknown as ActivityActivationView;
    const workflow = {
      workflowInstanceId: 'workflow-00000000000000000000000001',
      workItemId: 'work-00000000000000000000000001',
      orchestrationGroupId: 'group-00000000000000000000000001',
      acceptedOutcomes: [],
    } as never;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow, activation }],
        listWaiting: async () => [],
        acceptOutcome: async () => {
          accepted = true;
          throw new Error('Maintenance must prevent outcome acceptance');
        },
        markActivationStarted: async () => {
          throw new Error('No activation should start during maintenance');
        },
      },
      {
        recoverActive: async () => [],
        attempt: async () => {
          throw new Error('No execution attempt should begin during maintenance');
        },
        list: async () => {
          paused = true;
          return [
            {
              runId: 'run-00000000000000000000000001',
              status: 'succeeded',
              outcome: { kind: 'done' },
            },
          ] as never;
        },
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      {
        ids: { next: () => 'command-00000000000000000000000001' } as never,
        isDispatchPaused: async () => paused,
      },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
    expect(accepted).toBe(false);
  });

  it('does not recover or reconcile while the composed maintenance pause is active', async () => {
    let recovered = false;
    let reconciled = false;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => {
          reconciled = true;
        },
        listPendingActivations: async () => [],
        listWaiting: async () => [],
        acceptOutcome: async () => {
          throw new Error('No outcome should be accepted during maintenance');
        },
        markActivationStarted: async () => {
          throw new Error('No activation should start during maintenance');
        },
      },
      {
        recoverActive: async () => {
          recovered = true;
          return [];
        },
        attempt: async () => {
          throw new Error('No execution attempt should begin during maintenance');
        },
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      {
        ids: { next: () => 'command-00000000000000000000000001' } as never,
        isDispatchPaused: async () => true,
      },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
    expect(recovered).toBe(false);
    expect(reconciled).toBe(false);
  });

  it('does no work when no activation is pending', async () => {
    expect(await (await world()).advance()).toEqual({ kind: 'no-work' });
  });

  it('reports a started Run as progress and accepts its completed outcome through recovery', async () => {
    const activation = { activationId: 'activation-00000000000000000000000001' } as never;
    const workflow = {
      workflowInstanceId: 'workflow-00000000000000000000000001',
      workItemId: 'work-00000000000000000000000001',
      orchestrationGroupId: 'group-00000000000000000000000001',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    let run = {
      runId: 'run-00000000000000000000000001',
      status: 'started',
    } as unknown as RunView;
    let attempted = false;
    let pending = true;
    let markedStarted = 0;
    let accepted = 0;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => (pending ? [{ workflow, activation }] : []),
        listWaiting: async () => [],
        acceptOutcome: async () => {
          accepted++;
          pending = false;
          return workflow;
        },
        markActivationStarted: async () => {
          markedStarted++;
          return workflow;
        },
      },
      {
        attempt: async () => {
          attempted = true;
          return run;
        },
        list: async () => (attempted ? [run] : []),
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      { ids: { next: () => 'command-00000000000000000000000001' } as never },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toEqual({
      kind: 'progressed',
      activationId: 'activation-00000000000000000000000001',
      runId: run.runId,
    });
    expect(markedStarted).toBe(1);
    expect(accepted).toBe(0);

    run = { ...run, status: 'succeeded', outcome: { kind: 'done' } } as RunView;
    await expect(advance({ maxProgress: 1 })).resolves.toEqual({
      kind: 'progressed',
      activationId: 'activation-00000000000000000000000001',
      runId: run.runId,
    });
    expect(accepted).toBe(1);
    await expect(advance({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });
    expect(accepted).toBe(1);
  });

  it('performs one execution attempt and recovers its completed activation once', async () => {
    const test = await world();
    const work = await test.createWork({ objective: 'ship' });
    await test.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });
    expect((await test.advance(work.workItemId)).kind).toBe('progressed');
    expect((await test.advance(work.workItemId)).kind).toBe('progressed');
    expect(await test.advance(work.workItemId)).toEqual({ kind: 'no-work' });
    expect((await test.viewRuns()).length).toBe(1);
  });
});
