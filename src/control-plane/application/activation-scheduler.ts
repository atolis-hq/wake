/* eslint-disable complexity, max-lines-per-function */
import { RunStatus } from '../../execution/index.js';
import { correlationId, EventActorKind, type Clock } from '../../kernel/index.js';
import { isAmbiguityResolutionBlock, WorkflowStatus } from '../../orchestration/index.js';
import type { ResourceService } from '../../resources/index.js';
import { WorkStatus } from '../../work/index.js';
import { ControlStreamKind } from '../contracts/streams.js';
import type { AdvanceOptions, AdvanceResult } from '../contracts/views.js';
import { DispatchPolicy } from '../domain/dispatch-policy.js';
import type {
  ActivationSchedulerDependencies,
  ExecutionPort,
  OrchestrationPort,
} from './activation-scheduler-ports.js';
import {
  isRunnerQuotaOutcome,
  reportUnappliedRunnerQuotaRetry,
  runDispatchLoop,
  runnerQuotaMessage,
} from './advance-once-dispatch.js';
import {
  findUnresolvedSucceededTerminal,
  findUnresolvedTerminal,
} from './execution-reconciliation.js';

export interface ActivationScheduler {
  runOnce(options: AdvanceOptions, signal?: AbortSignal): Promise<AdvanceResult>;
}

export function createActivationScheduler(
  orchestration: OrchestrationPort,
  execution: ExecutionPort,
  resources: ResourceService,
  clock: Clock,
  dependencies: ActivationSchedulerDependencies,
): ActivationScheduler {
  const runnerIneligibility = dependencies.runnerIneligibility ?? (async () => new Set());
  const isDispatchPaused = dependencies.isDispatchPaused ?? (async () => false);
  const workspaceRecovery = dependencies.workspaceRecovery;
  const transcriptRetention = dependencies.transcriptRetention;
  const dispatchPolicy = dependencies.dispatchPolicy ?? new DispatchPolicy({ maxDispatches: 1 });
  const maxConcurrentRuns = dependencies.maxConcurrentRuns ?? 1;
  const maxDispatches = dependencies.maxDispatches ?? 1;
  const context = (cause: string) => ({
    commandId: dependencies.ids.next('command'),
    correlationId: correlationId(cause),
    occurredAt: clock.now().toISOString(),
    actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
  });
  const run = async (options: AdvanceOptions): Promise<AdvanceResult> => {
    if (options.maxProgress < 1) return { kind: 'exhausted', progressCount: 0 };
    if (await isDispatchPaused()) return { kind: 'paused' };
    if (workspaceRecovery !== undefined) {
      await workspaceRecovery.recover(await execution.list(), {
        isPaused: isDispatchPaused,
        retainWorkItem: async (workItemId) => {
          const work = await dependencies.work?.get(workItemId);
          return work?.state === WorkStatus.Open && work.deleted !== true;
        },
        onWorkspaceReclaimed: async (workItemId) => {
          if (await isDispatchPaused()) return false;
          const work = await dependencies.work?.get(workItemId);
          if (work?.state !== WorkStatus.Closed) return true;
          try {
            return (await transcriptRetention?.markClosedWorkItem(workItemId)) ?? true;
          } catch {
            return false;
          }
        },
      });
    }
    if (await isDispatchPaused()) return { kind: 'paused' };
    await execution.recoverActive?.(ControlStreamKind.Global);
    if (await isDispatchPaused()) return { kind: 'paused' };
    if (transcriptRetention !== undefined) {
      for (const workItemId of (await dependencies.closedWorkItemIds?.()) ?? []) {
        if (await isDispatchPaused()) return { kind: 'paused' };
        try {
          await transcriptRetention.markClosedWorkItem(workItemId);
        } catch {
          // Retention is operational filesystem maintenance, not Run lifecycle state.
        }
      }
    }
    if (await isDispatchPaused()) return { kind: 'paused' };
    try {
      await transcriptRetention?.sweep();
    } catch {
      // Retention is operational filesystem maintenance, not Run lifecycle state.
    }
    if (await isDispatchPaused()) return { kind: 'paused' };
    await orchestration.reconcileChildCompletions(context('child-completion-reconciliation'));
    if (await isDispatchPaused()) return { kind: 'paused' };
    const rawPending = await orchestration.listPendingActivations(options.workItemId);
    const pending = (
      await Promise.all(
        rawPending.map(async (candidate) => {
          const work = await dependencies.work?.get(candidate.workflow.workItemId);
          return work?.frozen || work?.deleted ? null : candidate;
        }),
      )
    ).filter((candidate): candidate is (typeof rawPending)[number] => candidate !== null);
    const blocked = ((await orchestration.listAll?.()) ?? []).flatMap((workflow) =>
      workflow.status === WorkflowStatus.Blocked &&
      workflow.pendingActivation !== undefined &&
      (options.workItemId === undefined || workflow.workItemId === options.workItemId)
        ? [{ workflow, activation: workflow.pendingActivation }]
        : [],
    );
    const ambiguityBlocked = blocked.filter((item) =>
      isAmbiguityResolutionBlock(item.workflow.blockReason),
    );
    const recovery =
      (await findUnresolvedTerminal(pending, execution)) ??
      (await findUnresolvedTerminal(ambiguityBlocked, execution)) ??
      (await findUnresolvedSucceededTerminal(blocked, execution));
    if (recovery !== undefined) {
      if (await isDispatchPaused()) return { kind: 'paused' };
      if (recovery.run.status === RunStatus.Succeeded) {
        if (isRunnerQuotaOutcome(recovery.run.outcome!)) {
          const retried = await orchestration.retryRunnerQuotaFailure?.(
            recovery.item.workflow.workflowInstanceId,
            {
              activationId: recovery.item.activation.activationId,
              runId: recovery.run.runId,
              runnerName: recovery.run.runner?.name ?? 'unknown-runner',
              message: runnerQuotaMessage(recovery.run.outcome!),
            },
            context(recovery.run.runId),
          );
          reportUnappliedRunnerQuotaRetry(retried, {
            activationId: recovery.item.activation.activationId,
            runId: recovery.run.runId,
          });
        } else {
          await orchestration.acceptOutcome(
            {
              workflowInstanceId: recovery.item.workflow.workflowInstanceId,
              activationId: recovery.item.activation.activationId,
              outcome: recovery.run.outcome!,
            },
            context(recovery.run.runId),
          );
        }
        return {
          kind: 'progressed',
          dispatched: [
            { activationId: recovery.item.activation.activationId, runId: recovery.run.runId },
          ],
        };
      }
      await orchestration.resolveExecutionFailure?.(
        recovery.item.workflow.workflowInstanceId,
        {
          activationId: recovery.item.activation.activationId,
          runId: recovery.run.runId,
          reason: recovery.run.failure?.message ?? 'execution failed',
        },
        context(recovery.run.runId),
      );
      return {
        kind: WorkflowStatus.Blocked,
        workflowInstanceId: recovery.item.workflow.workflowInstanceId,
        reason: recovery.run.failure?.message ?? 'execution failed',
      };
    }
    return runDispatchLoop(pending, {
      orchestration,
      execution,
      resources,
      dispatchPolicy,
      maxConcurrentRuns,
      maxDispatches,
      runnerIneligibility,
      isDispatchPaused,
      commandContext: context,
    });
  };
  const serialise = dependencies.schedulerSerialiser ?? createInProcessSerialiser();
  return { runOnce: (options, signal) => serialise(() => run(options), signal) };
}

function createInProcessSerialiser() {
  let prior: Promise<void> = Promise.resolve();
  return async <Value>(operation: () => Promise<Value>, signal?: AbortSignal): Promise<Value> => {
    const current = prior.then(async () => {
      throwIfAborted(signal);
      return operation();
    });
    prior = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Activation scheduler run aborted');
}
