/* eslint-disable complexity, max-lines-per-function */
import {
  ActivityFailureCode,
  ActivityOutcomeKind,
  type ActivityOutcome,
} from '../../activities/index.js';
import type { RunView } from '../../execution/index.js';
import { ActivationClaimConflictError, RunStatus, WorkspaceMode } from '../../execution/index.js';
import type { CommandContext } from '../../kernel/index.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../../orchestration/index.js';
import { WorkflowStatus } from '../../orchestration/index.js';
import type { ResourceService } from '../../resources/index.js';
import type { AdvanceResult, DispatchedRun } from '../contracts/views.js';
import type { DispatchPolicy } from '../domain/dispatch-policy.js';
import type { ExecutionPort, OrchestrationPort } from './advance-once-ports.js';
import { isExecutionFailureTerminal } from './execution-reconciliation.js';

export interface DispatchLoopContext {
  readonly orchestration: OrchestrationPort;
  readonly execution: ExecutionPort;
  readonly resources: ResourceService;
  readonly dispatchPolicy: DispatchPolicy;
  readonly maxConcurrentRuns: number;
  readonly maxDispatches: number;
  readonly runnerIneligibility: () => Promise<ReadonlySet<string>>;
  readonly isDispatchPaused: () => Promise<boolean>;
  readonly commandContext: (cause: string) => CommandContext;
}

interface PendingActivation {
  readonly workflow: WorkflowInstanceView;
  readonly activation: ActivityActivationView;
}

function isRunnerQuotaOutcome(outcome: ActivityOutcome): boolean {
  return (
    outcome.kind === ActivityOutcomeKind.Failed &&
    typeof outcome.data === 'object' &&
    outcome.data !== null &&
    'reason' in outcome.data &&
    (outcome.data as { reason?: unknown }).reason === ActivityFailureCode.RunnerQuotaExceeded
  );
}

function runnerQuotaMessage(outcome: ActivityOutcome): string {
  const data = outcome.data as { message?: unknown };
  return typeof data.message === 'string' ? data.message : 'runner reported quota exhaustion';
}

/**
 * Fills open capacity within one Advancement call: dispatches ready
 * activations one at a time, rechecking `maxConcurrentRuns` and reselecting
 * fresh candidates after every dispatch (per #346's capacity-recheck
 * principle), until capacity, the per-call `maxDispatches` burst cap, or
 * eligible candidates are exhausted. Candidates dispatched earlier in the
 * same call are excluded from later selection via `dispatchedIds`, since
 * their `RunStarted` event is not guaranteed visible through
 * `execution.list()` yet.
 */
export async function runDispatchLoop(
  pending: readonly PendingActivation[],
  ctx: DispatchLoopContext,
): Promise<AdvanceResult> {
  const dispatched: DispatchedRun[] = [];
  const dispatchedIds = new Set<string>();
  let stopReason: AdvanceResult | undefined;

  while (dispatched.length < ctx.maxDispatches) {
    const allRuns = await ctx.execution.list();
    if (allRuns.filter((run) => run.status === RunStatus.Started).length >= ctx.maxConcurrentRuns) {
      stopReason = { kind: 'no-work' };
      break;
    }
    const selectedCandidate = ctx.dispatchPolicy.select(
      await Promise.all(
        pending.map(async (item, requestedPosition) => ({
          workItemId: item.workflow.workItemId,
          activationId: item.activation.activationId,
          requestedPosition,
          hasActiveRun:
            dispatchedIds.has(item.activation.activationId) ||
            (await ctx.execution.list(item.activation.activationId)).some(
              (run) => run.status === RunStatus.Started,
            ) ||
            allRuns.some(
              (run) =>
                run.status === RunStatus.Started &&
                run.workflowInstanceId === item.workflow.workflowInstanceId &&
                run.workspace?.mode === WorkspaceMode.Branch,
            ),
          cancelled: false,
        })),
      ),
    )[0];
    const selected =
      selectedCandidate === undefined
        ? undefined
        : pending.find((item) => item.activation.activationId === selectedCandidate.activationId);
    if (selected === undefined) {
      const waiting = (await ctx.orchestration.listWaiting()).find((view) => view !== null);
      stopReason =
        waiting === undefined
          ? { kind: 'no-work' }
          : { kind: WorkflowStatus.Waiting, workflowInstanceId: waiting.workflowInstanceId };
      break;
    }
    // Recheck at the dispatch boundary so maintenance cannot race a selected activation.
    if (await ctx.isDispatchPaused()) {
      stopReason = { kind: 'paused' };
      break;
    }
    if (
      (await ctx.orchestration.validateActivationDispatch?.(
        selected.workflow.workflowInstanceId,
        ctx.commandContext(selected.activation.activationId),
      )) === false
    ) {
      stopReason = { kind: 'no-work' };
      break;
    }
    await ctx.orchestration.markActivationStarted(
      selected.workflow.workflowInstanceId,
      selected.activation.activationId,
      ctx.commandContext(selected.activation.activationId),
    );
    const correlated = await ctx.resources.correlationsForWork(selected.workflow.workItemId);
    const resourceViews = (
      await Promise.all(correlated.map((entry) => ctx.resources.get(entry.resourceId)))
    ).filter((resource) => resource !== null);
    const ineligible = await ctx.runnerIneligibility();
    let run: RunView;
    try {
      run = await ctx.execution.attempt(selected.activation, {
        workItemId: selected.workflow.workItemId,
        workflowInstanceId: selected.workflow.workflowInstanceId,
        orchestrationGroupId: selected.workflow.orchestrationGroupId,
        resources: resourceViews,
        sessionPolicy:
          selected.workflow.parentWorkflowInstanceId === undefined ? 'resume-stage' : 'fresh',
        awaitImmediateCompletion: true,
        ...(ineligible.size === 0 ? {} : { ineligibleRunners: ineligible }),
      });
    } catch (error) {
      if (error instanceof ActivationClaimConflictError) {
        stopReason = { kind: 'no-work' };
        break;
      }
      throw error;
    }
    if (run.status === RunStatus.Succeeded && run.outcome !== undefined) {
      if (isRunnerQuotaOutcome(run.outcome)) {
        await ctx.orchestration.retryRunnerQuotaFailure?.(
          selected.workflow.workflowInstanceId,
          {
            activationId: selected.activation.activationId,
            runId: run.runId,
            runnerName: run.runner?.name ?? 'unknown-runner',
            message: runnerQuotaMessage(run.outcome),
          },
          ctx.commandContext(run.runId),
        );
      } else {
        if (await ctx.isDispatchPaused()) {
          stopReason = { kind: 'paused' };
          break;
        }
        await ctx.orchestration.acceptOutcome(
          {
            workflowInstanceId: selected.workflow.workflowInstanceId,
            activationId: selected.activation.activationId,
            outcome: run.outcome,
          },
          ctx.commandContext(run.runId),
        );
      }
    }
    if (isExecutionFailureTerminal(run.status))
      await ctx.orchestration.resolveExecutionFailure?.(
        selected.workflow.workflowInstanceId,
        {
          activationId: selected.activation.activationId,
          runId: run.runId,
          reason: run.failure?.message ?? 'execution failed',
        },
        ctx.commandContext(run.runId),
      );
    if (run.status !== RunStatus.Succeeded && run.status !== RunStatus.Started) {
      stopReason = {
        kind: WorkflowStatus.Blocked,
        workflowInstanceId: selected.workflow.workflowInstanceId,
        reason: run.failure?.message ?? 'execution failed',
      };
      break;
    }
    dispatched.push({ activationId: selected.activation.activationId, runId: run.runId });
    dispatchedIds.add(selected.activation.activationId);
  }

  return dispatched.length > 0
    ? { kind: 'progressed', dispatched }
    : (stopReason ?? { kind: 'no-work' });
}
