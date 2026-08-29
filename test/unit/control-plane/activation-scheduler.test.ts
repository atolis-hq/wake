import { describe, expect, it } from 'vitest';
import {
  createActivationScheduler,
  type ActivationSchedulerSerialiser,
} from '../../../src/control-plane/index.js';
import type {
  ActivityActivationView,
  WorkflowInstanceView,
} from '../../../src/orchestration/index.js';

function candidate(id = 'one') {
  return {
    workflow: {
      workflowInstanceId: `workflow-${id}`,
      workItemId: `work-${id}`,
      orchestrationGroupId: `group-${id}`,
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView,
    activation: { activationId: `activation-${id}` } as unknown as ActivityActivationView,
  };
}

describe('ActivationScheduler', () => {
  it('preserves recovery and terminal reconciliation before dispatch selection', async () => {
    const trace: string[] = [];
    const pending = candidate();
    const scheduler = createActivationScheduler(
      {
        reconcileChildCompletions: async () => {
          trace.push('child-reconciliation');
        },
        listPendingActivations: async () => {
          trace.push('pending');
          return [pending];
        },
        listWaiting: async () => [],
        acceptOutcome: async () => {
          trace.push('terminal-reconciliation');
          return pending.workflow;
        },
        markActivationStarted: async () => {
          throw new Error('terminal reconciliation must precede dispatch');
        },
      },
      {
        recoverActive: async () => {
          trace.push('active-recovery');
          return [];
        },
        attempt: async () => {
          throw new Error('terminal reconciliation must precede dispatch');
        },
        list: async () =>
          [
            {
              runId: 'run-one',
              status: 'succeeded',
              activationId: pending.activation.activationId,
              outcome: { kind: 'done' },
            },
          ] as never,
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-29T00:00:00.000Z') },
      {
        ids: { next: () => 'command-one' } as never,
        isDispatchPaused: async () => {
          trace.push('pause-gate');
          return false;
        },
        work: {
          get: async () => ({ state: 'closed' as never }),
        },
        workspaceRecovery: {
          recover: async (_runs, hooks) => {
            trace.push('workspace-recovery');
            await hooks?.onWorkspaceReclaimed?.(pending.workflow.workItemId);
            return { reclaimed: 0, failures: [] };
          },
        },
        transcriptRetention: {
          markClosedWorkItem: async () => {
            trace.push('transcript-cleanup');
            return true;
          },
          sweep: async () => undefined,
        },
      },
    );

    await expect(scheduler.runOnce({ maxProgress: 1 })).resolves.toEqual({
      kind: 'progressed',
      dispatched: [{ activationId: 'activation-one', runId: 'run-one' }],
    });
    expect(trace).toEqual(
      expect.arrayContaining([
        'pause-gate',
        'workspace-recovery',
        'transcript-cleanup',
        'active-recovery',
        'child-reconciliation',
        'pending',
        'terminal-reconciliation',
      ]),
    );
    expect(trace.indexOf('workspace-recovery')).toBeLessThan(trace.indexOf('active-recovery'));
    expect(trace.indexOf('transcript-cleanup')).toBeLessThan(trace.indexOf('active-recovery'));
    expect(trace.indexOf('active-recovery')).toBeLessThan(trace.indexOf('child-reconciliation'));
    expect(trace.indexOf('child-reconciliation')).toBeLessThan(
      trace.indexOf('terminal-reconciliation'),
    );
  });

  it('uses the existing fair capacity-aware dispatch after recovery finds no terminal Run', async () => {
    const trace: string[] = [];
    const activeRuns = new Set<string>();
    const first = candidate('first');
    const second = candidate('second');
    const scheduler = createActivationScheduler(
      {
        reconcileChildCompletions: async () => {
          trace.push('child-reconciliation');
        },
        listPendingActivations: async () => [first, second],
        listWaiting: async () => [],
        acceptOutcome: async () => first.workflow,
        markActivationStarted: async (_workflowId, activationId) => {
          trace.push(`activation-claim:${activationId}`);
          return activationId === first.activation.activationId ? first.workflow : second.workflow;
        },
      },
      {
        attempt: async (activation) => {
          trace.push(`run-started:${activation.activationId}`);
          activeRuns.add(activation.activationId);
          return { runId: `run-${activation.activationId}`, status: 'started' } as never;
        },
        list: async () =>
          [...activeRuns].map((activationId) => ({ activationId, status: 'started' })) as never,
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-29T00:00:00.000Z') },
      { ids: { next: () => 'command-two' } as never, maxConcurrentRuns: 1, maxDispatches: 2 },
    );

    await expect(scheduler.runOnce({ maxProgress: 1 })).resolves.toEqual({
      kind: 'progressed',
      dispatched: [{ activationId: 'activation-first', runId: 'run-activation-first' }],
    });
    expect(trace).toEqual([
      'child-reconciliation',
      'activation-claim:activation-first',
      'run-started:activation-first',
    ]);
  });

  it('serialises capacity read, activation claim, workspace acquisition, and RunStarted', async () => {
    const activeRuns = new Set<string>();
    const trace: string[] = [];
    const serialiser = serialiseInOrder();
    const first = candidate('first');
    const second = candidate('second');
    const scheduler = (pending: ReturnType<typeof candidate>) =>
      createActivationScheduler(
        {
          reconcileChildCompletions: async () => undefined,
          listPendingActivations: async () => [pending],
          listWaiting: async () => [],
          acceptOutcome: async () => pending.workflow,
          markActivationStarted: async () => {
            trace.push(`activation-claim:${pending.activation.activationId}`);
            return pending.workflow;
          },
        },
        {
          attempt: async () => {
            trace.push(`workspace-acquire:${pending.activation.activationId}`);
            activeRuns.add(pending.activation.activationId);
            trace.push(`run-started:${pending.activation.activationId}`);
            return { runId: `run-${pending.activation.activationId}`, status: 'started' } as never;
          },
          list: async () =>
            [...activeRuns].map((activationId) => ({ activationId, status: 'started' })) as never,
        },
        { correlationsForWork: async () => [] } as never,
        { now: () => new Date('2026-08-29T00:00:00.000Z') },
        {
          ids: { next: () => 'command-three' } as never,
          maxConcurrentRuns: 1,
          schedulerSerialiser: serialiser,
        },
      );

    const [firstResult, secondResult] = await Promise.all([
      scheduler(first).runOnce({ maxProgress: 1 }),
      scheduler(second).runOnce({ maxProgress: 1 }),
    ]);

    expect(
      [firstResult, secondResult].filter((result) => result.kind === 'progressed'),
    ).toHaveLength(1);
    expect(activeRuns).toEqual(new Set(['activation-first']));
    expect(trace).toEqual([
      'activation-claim:activation-first',
      'workspace-acquire:activation-first',
      'run-started:activation-first',
    ]);
  });
});

function serialiseInOrder(): ActivationSchedulerSerialiser {
  let prior: Promise<void> = Promise.resolve();
  return async <Value>(operation: () => Promise<Value>) => {
    const current = prior.then(operation);
    prior = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}
