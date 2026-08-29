import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { createAdvanceOnce } from '../../../src/control-plane/index.js';
import {
  ActivationClaimConflictError,
  NoEligibleRunnerError,
  type RunView,
} from '../../../src/execution/index.js';
import { workflowName } from '../../../src/orchestration/contracts/identifiers.js';
import {
  type ActivityActivationView,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
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
    } as unknown as WorkflowInstanceView;
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

  it('retains workspaces only while their WorkItem remains open', async () => {
    const workItemId = 'work-00000000000000000000000001';
    let retained: boolean | undefined;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [],
        listWaiting: async () => [],
        acceptOutcome: async () => {
          throw new Error('No outcome should be accepted');
        },
        markActivationStarted: async () => {
          throw new Error('No activation should start');
        },
      },
      {
        attempt: async () => {
          throw new Error('No execution attempt should begin');
        },
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      {
        ids: { next: () => 'command-00000000000000000000000001' } as never,
        work: { get: async () => ({ state: 'open', deleted: false }) },
        workspaceRecovery: {
          recover: async (_runs, options) => {
            retained = await options?.retainWorkItem?.(workItemId as never);
            return { reclaimed: 0, failures: [] };
          },
        },
      },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });
    expect(retained).toBe(true);
  });

  it('does not mutate transcript retention after maintenance pauses during workspace recovery', async () => {
    const workItemId = 'work-00000000000000000000000001';
    let paused = false;
    let marked = 0;
    let swept = 0;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [],
        listWaiting: async () => [],
        acceptOutcome: async () => {
          throw new Error('No outcome should be accepted');
        },
        markActivationStarted: async () => {
          throw new Error('No activation should start');
        },
      },
      {
        attempt: async () => {
          throw new Error('No execution attempt should begin');
        },
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      {
        ids: { next: () => 'command-00000000000000000000000001' } as never,
        isDispatchPaused: async () => paused,
        work: { get: async () => ({ state: 'closed', deleted: false }) },
        workspaceRecovery: {
          recover: async () => {
            paused = true;
            return { reclaimed: 1, reclaimedWorkItemIds: [workItemId as never], failures: [] };
          },
        },
        transcriptRetention: {
          markClosedWorkItem: async () => {
            marked += 1;
            return true;
          },
          sweep: async () => {
            swept += 1;
          },
        },
      },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
    expect(marked).toBe(0);
    expect(swept).toBe(0);
  });

  it('does not fail a tick when another process holds the Activation claim', async () => {
    const workflow = {
      workflowInstanceId: 'workflow-00000000000000000000000001',
      workItemId: 'work-00000000000000000000000001',
      orchestrationGroupId: 'group-00000000000000000000000001',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const activation = {
      activationId: 'activation-00000000000000000000000001',
    } as unknown as ActivityActivationView;
    let attempts = 0;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow, activation }],
        listWaiting: async () => [],
        acceptOutcome: async () => workflow,
        markActivationStarted: async () => workflow,
      },
      {
        attempt: async () => {
          attempts += 1;
          throw new ActivationClaimConflictError(activation.activationId);
        },
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      { ids: { next: () => 'command-00000000000000000000000001' } as never },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });
    expect(attempts).toBe(1);
  });

  it('stops the dispatch loop for this tick, without crashing, when every pool runner is ineligible', async () => {
    const activation = { activationId: 'activation-1' } as unknown as ActivityActivationView;
    const workflow = {
      workflowInstanceId: 'workflow-1',
      workItemId: 'work-1',
      orchestrationGroupId: 'group-1',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow, activation }],
        listWaiting: async () => [],
        acceptOutcome: async () => workflow,
        markActivationStarted: async () => workflow,
      } as never,
      {
        attempt: async () => {
          throw new NoEligibleRunnerError('standard');
        },
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-19T00:00:00.000Z') },
      { ids: { next: () => 'command-1' } as never },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toMatchObject({ kind: 'no-work' });
  });

  it('does not dispatch a second branch workspace activity while its workflow has an active branch Run', async () => {
    const workflow = {
      workflowInstanceId: 'workflow-00000000000000000000000001',
      workItemId: 'work-00000000000000000000000001',
      orchestrationGroupId: 'group-00000000000000000000000001',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const activation = { activationId: 'activation-00000000000000000000000002' } as never;
    let attempts = 0;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow, activation }],
        listWaiting: async () => [],
        acceptOutcome: async () => workflow,
        markActivationStarted: async () => workflow,
      },
      {
        attempt: async () => {
          attempts++;
          return {} as never;
        },
        list: async (activationId) =>
          (activationId === undefined
            ? [
                {
                  status: 'started',
                  workflowInstanceId: workflow.workflowInstanceId,
                  workspace: { mode: 'branch', path: '/workspace' },
                },
              ]
            : []) as never,
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      { ids: { next: () => 'command-00000000000000000000000001' } as never },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });
    expect(attempts).toBe(0);
  });

  it('returns no-work at the global concurrent Run capacity and dispatches after capacity frees', async () => {
    const workflow = {
      workflowInstanceId: 'workflow-00000000000000000000000001',
      workItemId: 'work-00000000000000000000000001',
      orchestrationGroupId: 'group-00000000000000000000000001',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const activation = {
      activationId: 'activation-00000000000000000000000001',
    } as unknown as ActivityActivationView;
    let active = true;
    let attempts = 0;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow, activation }],
        listWaiting: async () => [],
        acceptOutcome: async () => workflow,
        markActivationStarted: async () => workflow,
      },
      {
        attempt: async () => {
          attempts += 1;
          return { status: 'started', runId: 'run-new' } as never;
        },
        list: async (activationId) =>
          (activationId === undefined && active
            ? [{ status: 'started', runId: 'run-existing', activationId: 'other-activation' }]
            : []) as never,
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      {
        ids: { next: () => 'command-00000000000000000000000001' } as never,
        maxConcurrentRuns: 1,
      },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });
    expect(attempts).toBe(0);

    active = false;
    await expect(advance({ maxProgress: 1 })).resolves.toMatchObject({
      kind: 'progressed',
      dispatched: [{ activationId: activation.activationId, runId: 'run-new' }],
    });
    expect(attempts).toBe(1);
  });

  it('serializes concurrent callers through the global capacity check and dispatch boundary', async () => {
    const workflow = {
      workflowInstanceId: 'workflow-00000000000000000000000001',
      workItemId: 'work-00000000000000000000000001',
      orchestrationGroupId: 'group-00000000000000000000000001',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const activation = { activationId: 'activation-00000000000000000000000001' } as never;
    const runs: RunView[] = [];
    let attempts = 0;
    let releaseAttempt!: () => void;
    let startedAttempt!: () => void;
    const attemptStarted = new Promise<void>((resolve) => {
      startedAttempt = resolve;
    });
    const attemptReleased = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow, activation }],
        listWaiting: async () => [],
        acceptOutcome: async () => workflow,
        markActivationStarted: async () => workflow,
      },
      {
        attempt: async () => {
          attempts += 1;
          startedAttempt();
          await attemptReleased;
          const run = { status: 'started', runId: 'run-00000000000000000000000001' } as RunView;
          runs.push(run);
          return run;
        },
        list: async () => runs,
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      {
        ids: { next: () => 'command-00000000000000000000000001' } as never,
        maxConcurrentRuns: 1,
      },
    );

    const first = advance({ maxProgress: 1 });
    await attemptStarted;
    const second = advance({ maxProgress: 1 });
    releaseAttempt();

    await expect(first).resolves.toMatchObject({ kind: 'progressed' });
    await expect(second).resolves.toEqual({ kind: 'no-work' });
    expect(attempts).toBe(1);
  });

  it('uses stage resume only for a primary workflow activation unless it requests a fresh session', async () => {
    const activation = {
      activationId: 'activation-00000000000000000000000001',
    } as unknown as ActivityActivationView;
    const primary = {
      workflowInstanceId: 'workflow-primary',
      workItemId: 'work-00000000000000000000000001',
      orchestrationGroupId: 'group-00000000000000000000000001',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const watch = {
      ...primary,
      workflowInstanceId: 'workflow-watch',
      parentWorkflowInstanceId: primary.workflowInstanceId,
    } as WorkflowInstanceView;
    const policies: string[] = [];
    let pending: readonly { workflow: WorkflowInstanceView; activation: ActivityActivationView }[] =
      [{ workflow: primary, activation }];
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => pending,
        listWaiting: async () => [],
        acceptOutcome: async () => primary,
        markActivationStarted: async () => primary,
      },
      {
        attempt: async (_activation, context) => {
          policies.push(context.sessionPolicy ?? 'missing');
          pending = [];
          return { status: 'started', runId: `run-${policies.length}` } as never;
        },
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      { ids: { next: () => 'command-00000000000000000000000001' } as never },
    );

    await advance({ maxProgress: 1 });
    pending = [{ workflow: watch, activation }];
    await advance({ maxProgress: 1 });
    pending = [{ workflow: primary, activation: { ...activation, sessionPolicy: 'fresh' } }];
    await advance({ maxProgress: 1 });

    expect(policies).toEqual(['resume-stage', 'fresh', 'fresh']);
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
      dispatched: [{ activationId: 'activation-00000000000000000000000001', runId: run.runId }],
    });
    expect(markedStarted).toBe(1);
    expect(accepted).toBe(0);

    run = { ...run, status: 'succeeded', outcome: { kind: 'done' } } as RunView;
    await expect(advance({ maxProgress: 1 })).resolves.toEqual({
      kind: 'progressed',
      dispatched: [{ activationId: 'activation-00000000000000000000000001', runId: run.runId }],
    });
    expect(accepted).toBe(1);
    await expect(advance({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });
    expect(accepted).toBe(1);
  });

  it('resolves a failed Run in orchestration before reporting it as blocked', async () => {
    const activation = {
      activationId: 'activation-00000000000000000000000001',
    } as unknown as ActivityActivationView;
    const workflow = {
      workflowInstanceId: 'workflow-00000000000000000000000001',
      workItemId: 'work-00000000000000000000000001',
      orchestrationGroupId: 'group-00000000000000000000000001',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const resolved: unknown[] = [];
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow, activation }],
        listWaiting: async () => [],
        acceptOutcome: async () => workflow,
        markActivationStarted: async () => workflow,
        resolveExecutionFailure: async (...input: unknown[]) => {
          resolved.push(input);
          return workflow;
        },
      } as never,
      {
        attempt: async () =>
          ({
            runId: 'run-00000000000000000000000001',
            status: 'failed',
            failure: { message: 'runner exited 1' },
          }) as never,
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      { ids: { next: () => 'command-00000000000000000000000001' } as never },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'runner exited 1',
    });
    expect(resolved).toEqual([
      [
        workflow.workflowInstanceId,
        {
          activationId: activation.activationId,
          runId: 'run-00000000000000000000000001',
          reason: 'runner exited 1',
        },
        expect.anything(),
      ],
    ]);
  });

  it('retries a quota-exceeded outcome through orchestration instead of accepting it', async () => {
    const activation = { activationId: 'activation-1' } as unknown as ActivityActivationView;
    const workflow = {
      workflowInstanceId: 'workflow-1',
      workItemId: 'work-1',
      orchestrationGroupId: 'group-1',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const accepted: unknown[] = [];
    const retried: unknown[] = [];
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow, activation }],
        listWaiting: async () => [],
        acceptOutcome: async (...input: unknown[]) => {
          accepted.push(input);
          return workflow;
        },
        markActivationStarted: async () => workflow,
        retryRunnerQuotaFailure: async (...input: unknown[]) => {
          retried.push(input);
          return workflow;
        },
      } as never,
      {
        attempt: async () =>
          ({
            runId: 'run-1',
            status: 'succeeded',
            runner: { name: 'codex' },
            outcome: {
              kind: 'failed',
              data: { reason: 'runner-quota-exceeded', message: "You've hit your usage limit." },
            },
          }) as never,
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-19T00:00:00.000Z') },
      { ids: { next: () => 'command-1' } as never },
    );

    await advance({ maxProgress: 1 });

    expect(accepted).toEqual([]);
    expect(retried).toEqual([
      [
        workflow.workflowInstanceId,
        {
          activationId: activation.activationId,
          runId: 'run-1',
          runnerName: 'codex',
          message: "You've hit your usage limit.",
        },
        expect.anything(),
      ],
    ]);
  });

  // A real agent Run is still 'started' when execution.attempt() returns, so its
  // quota outcome is only ever seen by this reconciliation path on a later tick.
  it('retries a quota-exceeded outcome found by terminal-Run reconciliation instead of accepting it', async () => {
    const activation = { activationId: 'activation-1' } as unknown as ActivityActivationView;
    const workflow = {
      workflowInstanceId: 'workflow-1',
      workItemId: 'work-1',
      orchestrationGroupId: 'group-1',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const accepted: unknown[] = [];
    const retried: unknown[] = [];
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow, activation }],
        listWaiting: async () => [],
        acceptOutcome: async (...input: unknown[]) => {
          accepted.push(input);
          return workflow;
        },
        markActivationStarted: async () => workflow,
        retryRunnerQuotaFailure: async (...input: unknown[]) => {
          retried.push(input);
          return workflow;
        },
      } as never,
      {
        attempt: async () => {
          throw new Error('Reconciliation must resolve the terminal Run before any dispatch');
        },
        list: async () =>
          [
            {
              runId: 'run-1',
              status: 'succeeded',
              runner: { name: 'codex' },
              outcome: {
                kind: 'failed',
                data: { reason: 'runner-quota-exceeded', message: "You've hit your usage limit." },
              },
            },
          ] as never,
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-19T00:00:00.000Z') },
      { ids: { next: () => 'command-1' } as never },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toEqual({
      kind: 'progressed',
      dispatched: [{ activationId: 'activation-1', runId: 'run-1' }],
    });
    expect(accepted).toEqual([]);
    expect(retried).toEqual([
      [
        workflow.workflowInstanceId,
        {
          activationId: activation.activationId,
          runId: 'run-1',
          runnerName: 'codex',
          message: "You've hit your usage limit.",
        },
        expect.anything(),
      ],
    ]);
  });

  it('accepts an ordinary non-quota failed outcome through acceptOutcome unchanged', async () => {
    const activation = { activationId: 'activation-1' } as unknown as ActivityActivationView;
    const workflow = {
      workflowInstanceId: 'workflow-1',
      workItemId: 'work-1',
      orchestrationGroupId: 'group-1',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const accepted: unknown[] = [];
    const retried: unknown[] = [];
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow, activation }],
        listWaiting: async () => [],
        acceptOutcome: async (...input: unknown[]) => {
          accepted.push(input);
          return workflow;
        },
        markActivationStarted: async () => workflow,
        retryRunnerQuotaFailure: async (...input: unknown[]) => {
          retried.push(input);
          return workflow;
        },
      } as never,
      {
        attempt: async () =>
          ({
            runId: 'run-1',
            status: 'succeeded',
            runner: { name: 'codex' },
            outcome: {
              kind: 'failed',
              data: { reason: 'runner-failed', message: 'runner exited 1' },
            },
          }) as never,
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-19T00:00:00.000Z') },
      { ids: { next: () => 'command-1' } as never },
    );

    await advance({ maxProgress: 1 });

    expect(retried).toEqual([]);
    expect(accepted).toEqual([
      [
        {
          workflowInstanceId: workflow.workflowInstanceId,
          activationId: activation.activationId,
          outcome: {
            kind: 'failed',
            data: { reason: 'runner-failed', message: 'runner exited 1' },
          },
        },
        expect.anything(),
      ],
    ]);
  });

  it.each(['failed', 'cancelled'] as const)(
    'resolves a detached %s Run before dispatching another attempt',
    async (status) => {
      const activation = {
        activationId: 'activation-00000000000000000000000001',
      } as unknown as ActivityActivationView;
      const workflow = {
        workflowInstanceId: 'workflow-00000000000000000000000001',
        workItemId: 'work-00000000000000000000000001',
        orchestrationGroupId: 'group-00000000000000000000000001',
        acceptedOutcomes: [],
      } as unknown as WorkflowInstanceView;
      let attempts = 0;
      const resolutions: unknown[] = [];
      const advance = createAdvanceOnce(
        {
          reconcileChildCompletions: async () => undefined,
          listPendingActivations: async () => [{ workflow, activation }],
          listWaiting: async () => [],
          acceptOutcome: async () => workflow,
          markActivationStarted: async () => workflow,
          resolveExecutionFailure: async (...input: unknown[]) => {
            resolutions.push(input);
            return workflow;
          },
        } as never,
        {
          attempt: async () => {
            attempts += 1;
            return { status: 'started', runId: 'unexpected-retry' } as never;
          },
          list: async () =>
            [
              {
                runId: 'run-00000000000000000000000001',
                status,
                activationId: activation.activationId,
                ...(status === 'cancelled' ? {} : { failure: { message: 'runner exited 1' } }),
              },
            ] as never,
        },
        { correlationsForWork: async () => [] } as never,
        { now: () => new Date('2026-08-11T00:00:00.000Z') },
        { ids: { next: () => 'command-00000000000000000000000001' } as never },
      );

      await expect(advance({ maxProgress: 1 })).resolves.toMatchObject({
        kind: 'blocked',
        reason: status === 'cancelled' ? 'execution failed' : 'runner exited 1',
      });
      expect(attempts).toBe(0);
      expect(resolutions).toHaveLength(1);
    },
  );

  it.each(['failed', 'cancelled', 'ambiguous'] as const)(
    'does not rescan an already blocked %s Run before dispatching unrelated ready work',
    async (status) => {
      const resolved = {
        workflowInstanceId: 'workflow-resolved',
        workItemId: 'work-resolved',
        orchestrationGroupId: 'group-resolved',
        status: 'blocked',
        acceptedOutcomes: [],
        pendingActivation: { activationId: 'activation-resolved' },
      } as unknown as WorkflowInstanceView;
      const pending = {
        workflowInstanceId: 'workflow-pending',
        workItemId: 'work-pending',
        orchestrationGroupId: 'group-pending',
        acceptedOutcomes: [],
      } as unknown as WorkflowInstanceView;
      const activation = {
        activationId: 'activation-pending',
      } as unknown as ActivityActivationView;
      let attempts = 0;
      const advance = createAdvanceOnce(
        {
          reconcileChildCompletions: async () => undefined,
          listPendingActivations: async () => [{ workflow: pending, activation }],
          listWaiting: async () => [],
          listAll: async () => [resolved, pending],
          acceptOutcome: async () => pending,
          markActivationStarted: async () => pending,
        },
        {
          attempt: async () => {
            attempts += 1;
            return { status: 'started', runId: 'run-pending' } as never;
          },
          list: async (activationId) =>
            (activationId === 'activation-resolved'
              ? [
                  {
                    status,
                    runId: 'run-resolved',
                    ...(status === 'cancelled' ? {} : { failure: { message: 'old failure' } }),
                  },
                ]
              : []) as never,
        },
        { correlationsForWork: async () => [] } as never,
        { now: () => new Date('2026-08-11T00:00:00.000Z') },
        { ids: { next: () => 'command-00000000000000000000000001' } as never },
      );

      await expect(advance({ maxProgress: 1 })).resolves.toMatchObject({
        kind: 'progressed',
        dispatched: [{ activationId: 'activation-pending', runId: 'run-pending' }],
      });
      expect(attempts).toBe(1);
    },
  );

  it('reconciles a succeeded outcome resolved after its workflow was blocked', async () => {
    const workflow = {
      workflowInstanceId: 'workflow-resolved',
      workItemId: 'work-resolved',
      orchestrationGroupId: 'group-resolved',
      status: 'blocked',
      acceptedOutcomes: [],
      pendingActivation: { activationId: 'activation-resolved' },
    } as unknown as WorkflowInstanceView;
    let accepted = 0;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [],
        listWaiting: async () => [],
        listAll: async () => [workflow],
        acceptOutcome: async () => {
          accepted += 1;
          return workflow;
        },
        markActivationStarted: async () => workflow,
      },
      {
        attempt: async () => {
          throw new Error('A resolved outcome should be accepted before dispatch');
        },
        list: async () =>
          [
            {
              status: 'succeeded',
              runId: 'run-resolved',
              outcome: { kind: 'done' },
            },
          ] as never,
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      { ids: { next: () => 'command-00000000000000000000000001' } as never },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toMatchObject({
      kind: 'progressed',
      dispatched: [{ activationId: 'activation-resolved', runId: 'run-resolved' }],
    });
    expect(accepted).toBe(1);
  });

  it('reconciles an operator-resolved failed ambiguous Run without replaying it', async () => {
    const workflow = {
      workflowInstanceId: 'workflow-ambiguous',
      workItemId: 'work-ambiguous',
      orchestrationGroupId: 'group-ambiguous',
      status: 'blocked',
      blockReason: 'run-ambiguous-after-3-attempts',
      acceptedOutcomes: [],
      pendingActivation: { activationId: 'activation-ambiguous' },
    } as unknown as WorkflowInstanceView;
    const resolved: unknown[] = [];
    let attempted = false;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [],
        listWaiting: async () => [],
        listAll: async () => [workflow],
        acceptOutcome: async () => workflow,
        markActivationStarted: async () => workflow,
        resolveExecutionFailure: async (...input: unknown[]) => {
          resolved.push(input);
          return workflow;
        },
      } as never,
      {
        attempt: async () => {
          attempted = true;
          return { status: 'started', runId: 'unexpected-replay' } as never;
        },
        list: async () =>
          [
            {
              status: 'failed',
              runId: 'run-ambiguous',
              failure: { message: 'operator confirmed failure' },
            },
          ] as never,
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-17T01:00:00.000Z') },
      { ids: { next: () => 'command-00000000000000000000000001' } as never },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'operator confirmed failure',
    });
    expect(resolved).toEqual([
      [
        workflow.workflowInstanceId,
        {
          activationId: workflow.pendingActivation!.activationId,
          runId: 'run-ambiguous',
          reason: 'operator confirmed failure',
        },
        expect.anything(),
      ],
    ]);
    expect(attempted).toBe(false);
  });

  it('does not start an activation rejected by the dispatch-boundary watch check', async () => {
    const workflow = {
      workflowInstanceId: 'stale-watch-child',
      workItemId: 'work-stale-watch-child',
      orchestrationGroupId: 'group-stale-watch-child',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const activation = { activationId: 'activation-stale-watch-child' } as ActivityActivationView;
    let started = false;
    let attempted = false;
    const advance = createAdvanceOnce(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow, activation }],
        listWaiting: async () => [],
        validateActivationDispatch: async () => false,
        acceptOutcome: async () => workflow,
        markActivationStarted: async () => {
          started = true;
          return workflow;
        },
      },
      {
        attempt: async () => {
          attempted = true;
          return { status: 'started', runId: 'run-stale-watch-child' } as never;
        },
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      { ids: { next: () => 'command-00000000000000000000000001' } as never },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });
    expect(started).toBe(false);
    expect(attempted).toBe(false);
  });

  it('performs one execution attempt and recovers its completed activation once', async () => {
    const test = await world();
    const work = await test.createWork({ objective: 'ship' });
    await test.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });
    expect((await test.advance(work.workItemId)).kind).toBe('progressed');
    expect((await test.advance(work.workItemId)).kind).toBe('no-work');
    expect(await test.advance(work.workItemId)).toEqual({ kind: 'no-work' });
    expect((await test.viewRuns()).length).toBe(1);
  });

  describe('filling open concurrency slots within one call', () => {
    function candidate(id: string) {
      const workflow = {
        workflowInstanceId: `workflow-${id}`,
        workItemId: `work-${id}`,
        orchestrationGroupId: `group-${id}`,
        acceptedOutcomes: [],
      } as unknown as WorkflowInstanceView;
      const activation = { activationId: `activation-${id}` } as unknown as ActivityActivationView;
      return { workflow, activation };
    }

    interface FakeRun {
      readonly runId: string;
      readonly status: string;
      readonly activationId: string;
    }

    function createOrchestration(
      pending: readonly { workflow: WorkflowInstanceView; activation: ActivityActivationView }[],
    ) {
      const started: string[] = [];
      const accepted: string[] = [];
      return {
        started,
        accepted,
        port: {
          reconcileChildCompletions: async () => undefined,
          listPendingActivations: async () => pending,
          listWaiting: async () => [],
          acceptOutcome: async (command: { activationId: string }) => {
            accepted.push(command.activationId);
            return pending.find((p) => p.activation.activationId === command.activationId)!
              .workflow;
          },
          markActivationStarted: async (_workflowInstanceId: string, activationId: string) => {
            started.push(activationId);
            return pending.find((p) => p.activation.activationId === activationId)!.workflow;
          },
        },
      };
    }

    // `reflectDispatches: false` simulates a RunStarted event not yet visible
    // through execution.list() within the same call, proving the loop
    // excludes same-call dispatches via its own tracked state, not by
    // relying on list() to reflect them.
    function createExecution(options: { reflectDispatches?: boolean } = {}) {
      const reflectDispatches = options.reflectDispatches ?? true;
      const attempts: string[] = [];
      const runs = new Map<string, FakeRun>();
      return {
        attempts,
        runs,
        port: {
          attempt: async (activation: ActivityActivationView) => {
            attempts.push(activation.activationId);
            const run: FakeRun = {
              runId: `run-${activation.activationId.slice('activation-'.length)}`,
              status: 'started',
              activationId: activation.activationId,
            };
            if (reflectDispatches) runs.set(activation.activationId, run);
            return run as never;
          },
          list: async (activationId?: string) => {
            const all = [...runs.values()];
            return (
              activationId === undefined
                ? all
                : all.filter((run) => run.activationId === activationId)
            ) as never;
          },
        },
      };
    }

    it('dispatches only one run under the default burst cap even with multiple ready candidates', async () => {
      const pending = [candidate('a'), candidate('b'), candidate('c')];
      const orchestration = createOrchestration(pending);
      const execution = createExecution();
      const advance = createAdvanceOnce(
        orchestration.port,
        execution.port,
        { correlationsForWork: async () => [] } as never,
        { now: () => new Date('2026-08-11T00:00:00.000Z') },
        { ids: { next: () => 'command-00000000000000000000000001' } as never },
      );

      await expect(advance({ maxProgress: 1 })).resolves.toEqual({
        kind: 'progressed',
        dispatched: [{ activationId: 'activation-a', runId: 'run-a' }],
      });
      expect(execution.attempts).toEqual(['activation-a']);
    });

    it('dispatches N runs in one call when maxConcurrentRuns and maxDispatches both allow it', async () => {
      const pending = [candidate('a'), candidate('b'), candidate('c')];
      const orchestration = createOrchestration(pending);
      const execution = createExecution();
      const advance = createAdvanceOnce(
        orchestration.port,
        execution.port,
        { correlationsForWork: async () => [] } as never,
        { now: () => new Date('2026-08-11T00:00:00.000Z') },
        {
          ids: { next: () => 'command-00000000000000000000000001' } as never,
          maxConcurrentRuns: 3,
          maxDispatches: 3,
        },
      );

      await expect(advance({ maxProgress: 1 })).resolves.toEqual({
        kind: 'progressed',
        dispatched: [
          { activationId: 'activation-a', runId: 'run-a' },
          { activationId: 'activation-b', runId: 'run-b' },
          { activationId: 'activation-c', runId: 'run-c' },
        ],
      });
      expect(execution.attempts).toEqual(['activation-a', 'activation-b', 'activation-c']);
    });

    it('stops exactly at the maxConcurrentRuns ceiling even with more ready work and burst capacity remaining', async () => {
      const pending = [candidate('a'), candidate('b'), candidate('c')];
      const orchestration = createOrchestration(pending);
      const execution = createExecution();
      execution.runs.set('activation-other', {
        runId: 'run-other',
        status: 'started',
        activationId: 'activation-other',
      });
      const advance = createAdvanceOnce(
        orchestration.port,
        execution.port,
        { correlationsForWork: async () => [] } as never,
        { now: () => new Date('2026-08-11T00:00:00.000Z') },
        {
          ids: { next: () => 'command-00000000000000000000000001' } as never,
          maxConcurrentRuns: 2,
          maxDispatches: 3,
        },
      );

      await expect(advance({ maxProgress: 1 })).resolves.toEqual({
        kind: 'progressed',
        dispatched: [{ activationId: 'activation-a', runId: 'run-a' }],
      });
      expect(execution.attempts).toEqual(['activation-a']);
    });

    it('stops exactly at the maxDispatches burst cap even when maxConcurrentRuns has more room', async () => {
      const pending = [candidate('a'), candidate('b'), candidate('c')];
      const orchestration = createOrchestration(pending);
      const execution = createExecution();
      const advance = createAdvanceOnce(
        orchestration.port,
        execution.port,
        { correlationsForWork: async () => [] } as never,
        { now: () => new Date('2026-08-11T00:00:00.000Z') },
        {
          ids: { next: () => 'command-00000000000000000000000001' } as never,
          maxConcurrentRuns: 5,
          maxDispatches: 2,
        },
      );

      await expect(advance({ maxProgress: 1 })).resolves.toEqual({
        kind: 'progressed',
        dispatched: [
          { activationId: 'activation-a', runId: 'run-a' },
          { activationId: 'activation-b', runId: 'run-b' },
        ],
      });
      expect(execution.attempts).toEqual(['activation-a', 'activation-b']);
    });

    it('does not select a candidate dispatched earlier in the same call again, even before its Run is visible', async () => {
      const pending = [candidate('a'), candidate('b')];
      const orchestration = createOrchestration(pending);
      const execution = createExecution({ reflectDispatches: false });
      const advance = createAdvanceOnce(
        orchestration.port,
        execution.port,
        { correlationsForWork: async () => [] } as never,
        { now: () => new Date('2026-08-11T00:00:00.000Z') },
        {
          ids: { next: () => 'command-00000000000000000000000001' } as never,
          maxConcurrentRuns: 2,
          maxDispatches: 2,
        },
      );

      await expect(advance({ maxProgress: 1 })).resolves.toEqual({
        kind: 'progressed',
        dispatched: [
          { activationId: 'activation-a', runId: 'run-a' },
          { activationId: 'activation-b', runId: 'run-b' },
        ],
      });
      expect(execution.attempts).toEqual(['activation-a', 'activation-b']);
    });
  });
});
