import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { createAdvanceOnce } from '../../../src/control-plane/index.js';
import { type RunView } from '../../../src/execution/index.js';
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

  it('uses stage resume only for a primary workflow activation', async () => {
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

    expect(policies).toEqual(['resume-stage', 'fresh']);
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
        attempt: async () => ({
          runId: 'run-00000000000000000000000001',
          status: 'failed',
          failure: { message: 'runner exited 1' },
        } as never),
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

  it.each(['failed', 'cancelled', 'ambiguous'] as const)(
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
        list: async () => [
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

  it('does not rescan a failure already resolved by orchestration', async () => {
    const resolved = {
      workflowInstanceId: 'workflow-resolved',
      workItemId: 'work-resolved',
      orchestrationGroupId: 'group-resolved',
      status: 'blocked',
      acceptedOutcomes: ['activation-resolved'],
      pendingActivation: { activationId: 'activation-resolved' },
    } as unknown as WorkflowInstanceView;
    const pending = {
      workflowInstanceId: 'workflow-pending',
      workItemId: 'work-pending',
      orchestrationGroupId: 'group-pending',
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView;
    const activation = { activationId: 'activation-pending' } as unknown as ActivityActivationView;
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
            ? [{ status: 'failed', runId: 'run-resolved', failure: { message: 'old failure' } }]
            : []) as never,
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-11T00:00:00.000Z') },
      { ids: { next: () => 'command-00000000000000000000000001' } as never },
    );

    await expect(advance({ maxProgress: 1 })).resolves.toMatchObject({
      kind: 'progressed',
      runId: 'run-pending',
    });
    expect(attempts).toBe(1);
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
