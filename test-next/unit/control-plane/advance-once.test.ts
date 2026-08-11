import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { createAdvanceOnce } from '../../../src-next/control-plane/index.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
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
    const activation = { activationId: 'activation-00000000000000000000000001' } as never;
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
  it('performs at most one execution attempt and never duplicates a completed activation', async () => {
    const test = await world();
    const work = await test.createWork({ objective: 'ship' });
    await test.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });
    expect((await test.advance(work.workItemId)).kind).toBe('progressed');
    expect(await test.advance(work.workItemId)).toEqual({ kind: 'no-work' });
    expect((await test.viewRuns()).length).toBe(1);
  });
});
