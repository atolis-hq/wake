import { deliveryCapacity } from '../domain/delivery-capacity.js';
import { dispatchResources } from './dispatch-resources.js';
import {
  isRunnerQuotaOutcome,
  reportUnappliedRunnerQuotaRetry,
  runnerQuotaMessage,
} from './runner-quota-outcome.js';
/* eslint-disable complexity, max-lines-per-function */
import type { CommandContext } from '@atolis-hq/eventing';
import {
  ActivationClaimConflictError,
  isActiveRunStatus,
  NoEligibleRunnerError,
  RunStatus,
  WorkspaceMode,
} from '../../execution/index.js';
import type {
  ActivityActivationView,
  PendingActivationPriority,
  WorkflowInstanceView,
} from '../../orchestration/index.js';
import { DelegationPendingError, WorkflowStatus } from '../../orchestration/index.js';
import { type ResourceService } from '../../resources/index.js';
import type { WorkService } from '../../work/index.js';
import type { AdvanceResult, DispatchedRun } from '../contracts/views.js';
import { neutralDispatchPriority, type DispatchPolicy } from '../domain/dispatch-policy.js';
import { canDispatchWorkItem, readOpenWorkItemIds } from '../domain/open-work-policy.js';
import type { ExecutionPort, OrchestrationPort } from './activation-scheduler-ports.js';
import { isExecutionFailureTerminal } from './execution-reconciliation.js';

export interface DispatchLoopContext {
  readonly orchestration: OrchestrationPort;
  readonly execution: ExecutionPort;
  readonly resources: ResourceService;
  readonly dispatchPolicy: DispatchPolicy;
  readonly maxConcurrentRuns: number;
  readonly maxDispatches: number;
  readonly maxOpenWorkItems: number | null;
  readonly work: Pick<WorkService, 'deliverySnapshot'> | undefined;
  readonly runnerIneligibility: () => Promise<ReadonlySet<string>>;
  readonly isDispatchPaused: () => Promise<boolean>;
  readonly commandContext: (cause: string) => CommandContext;
}

interface PendingActivation {
  readonly workflow: WorkflowInstanceView;
  readonly activation: ActivityActivationView;
  readonly priority?: PendingActivationPriority | undefined;
}

export async function advancementWasDurablyApplied(
  orchestration: OrchestrationPort,
  workflowInstanceId: WorkflowInstanceView['workflowInstanceId'],
  activationId: ActivityActivationView['activationId'],
): Promise<boolean> {
  const current = await orchestration.get?.(workflowInstanceId);
  return (
    current !== undefined && current !== null && current.acceptedOutcomes.includes(activationId)
  );
}

const maximumIsolationReasonLength = 2_000;

export function isolatedWorkflowReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `workflow advancement failed: ${message}`.slice(0, maximumIsolationReasonLength);
}

export async function blockIsolatedWorkflow(
  orchestration: OrchestrationPort,
  workflowInstanceId: string,
  error: unknown,
  context: CommandContext,
): Promise<string> {
  const reason = isolatedWorkflowReason(error);
  if (orchestration.block === undefined)
    throw new Error('Orchestration port cannot durably block an isolated workflow', {
      cause: error,
    });
  await orchestration.block(workflowInstanceId, reason, context);
  return reason;
}

/** Recheck capacity and select a fresh candidate after each dispatch. */
export async function runDispatchLoop(
  pending: readonly PendingActivation[],
  ctx: DispatchLoopContext,
): Promise<AdvanceResult> {
  const dispatched: DispatchedRun[] = [];
  const dispatchedIds = new Set<string>();
  const startedWorkflowIds = new Set<string>();
  const isolatedIds = new Set<string>();
  let isolated: Extract<AdvanceResult, { kind: typeof WorkflowStatus.Blocked }> | undefined;
  let stopReason: AdvanceResult | undefined;

  while (dispatched.length < ctx.maxDispatches) {
    const allRuns = await ctx.execution.list();
    const activeActivationIds = new Set(
      allRuns.filter((run) => isActiveRunStatus(run.status)).map((run) => run.activationId),
    );
    const branchActiveWorkflowIds = new Set(
      allRuns
        .filter(
          (run) => isActiveRunStatus(run.status) && run.workspace?.mode === WorkspaceMode.Branch,
        )
        .map((run) => run.workflowInstanceId),
    );
    if (allRuns.filter((run) => isActiveRunStatus(run.status)).length >= ctx.maxConcurrentRuns) {
      stopReason = { kind: 'no-work' };
      break;
    }
    const inventory = (await ctx.orchestration.listAll?.()) ?? pending.map((item) => item.workflow);
    // One synchronisation with Work per pass; every item is then answered from memory.
    const delivery = await ctx.work?.deliverySnapshot();
    const capacity = await deliveryCapacity(
      inventory,
      allRuns,
      delivery,
      ctx.orchestration.deliveryRunLimit?.bind(ctx.orchestration),
    );
    // Legacy test ports may omit listAll; production supplies the journal-backed inventory.
    const open =
      ctx.maxOpenWorkItems === null
        ? new Set<string>()
        : readOpenWorkItemIds(
            inventory.map((workflow) =>
              startedWorkflowIds.has(workflow.workflowInstanceId)
                ? { ...workflow, hasStartedActivation: true }
                : workflow,
            ),
            delivery,
          );
    const selectedCandidate = ctx.dispatchPolicy.select(
      pending
        .filter(
          (item) =>
            !isolatedIds.has(item.workflow.workflowInstanceId) &&
            !capacity.unavailable.has(item.workflow.workItemId) &&
            !capacity.full.has(
              capacity.roots.get(item.workflow.workItemId) ?? item.workflow.workItemId,
            ) &&
            canDispatchWorkItem(
              capacity.roots.get(item.workflow.workItemId) ?? item.workflow.workItemId,
              open,
              ctx.maxOpenWorkItems,
            ),
        )
        .map((item, requestedPosition) => ({
          workItemId: item.workflow.workItemId,
          activationId: item.activation.activationId,
          requestedPosition,
          priority: item.priority ?? neutralDispatchPriority,
          hasActiveRun:
            dispatchedIds.has(item.activation.activationId) ||
            activeActivationIds.has(item.activation.activationId) ||
            branchActiveWorkflowIds.has(item.workflow.workflowInstanceId),
          cancelled: false,
        })),
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
    const ineligible = await ctx.runnerIneligibility();
    try {
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
      startedWorkflowIds.add(selected.workflow.workflowInstanceId);
      const repositoryAssignment = await ctx.orchestration.repositoryAssignment?.(
        selected.workflow.workItemId,
      );
      const resourceViews = await dispatchResources(
        ctx.resources,
        selected.workflow.workItemId,
        repositoryAssignment,
      );
      const candidate = await ctx.orchestration.deliveryQaPreparation?.(
        selected.workflow.workflowInstanceId,
      );
      const run = await ctx.execution.attempt(selected.activation, {
        workItemId: selected.workflow.workItemId,
        workflowInstanceId: selected.workflow.workflowInstanceId,
        orchestrationGroupId: selected.workflow.orchestrationGroupId,
        resources: resourceViews,
        ...(candidate === undefined ? {} : { candidate }),
        ...(repositoryAssignment === undefined ? {} : { repositoryAssignment }),
        sessionPolicy:
          candidate !== undefined ||
          selected.activation.sessionPolicy === 'fresh' ||
          selected.workflow.parentWorkflowInstanceId !== undefined
            ? 'fresh'
            : 'resume-stage',
        awaitImmediateCompletion: true,
        ...(ineligible.size === 0 ? {} : { ineligibleRunners: ineligible }),
      });
      if (
        run.status === RunStatus.Succeeded &&
        run.outcome !== undefined &&
        isRunnerQuotaOutcome(run.outcome)
      ) {
        // No isDispatchPaused check here: a quota retry re-requests the same
        // stage's activity without publishing an outcome or consuming retry
        // budget, so it must not be held behind maintenance pause the way an
        // outward-publishing acceptOutcome call is below.
        const retried = await ctx.orchestration.retryRunnerQuotaFailure?.(
          selected.workflow.workflowInstanceId,
          {
            activationId: selected.activation.activationId,
            runId: run.runId,
            runnerName: run.runner?.name ?? 'unknown-runner',
            message: runnerQuotaMessage(run.outcome),
          },
          ctx.commandContext(run.runId),
        );
        reportUnappliedRunnerQuotaRetry(retried, {
          activationId: selected.activation.activationId,
          runId: run.runId,
        });
      } else if (run.status === RunStatus.Succeeded && run.outcome !== undefined) {
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
      if (isExecutionFailureTerminal(run.status))
        await ctx.orchestration.resolveExecutionFailure?.(
          selected.workflow.workflowInstanceId,
          {
            activationId: selected.activation.activationId,
            runId: run.runId,
            reason: run.failure?.message ?? 'execution failed',
            ...(run.failure === undefined ? {} : { failureKind: run.failure.kind }),
          },
          ctx.commandContext(run.runId),
        );
      if (run.status !== RunStatus.Succeeded && !isActiveRunStatus(run.status)) {
        stopReason = {
          kind: WorkflowStatus.Blocked,
          workflowInstanceId: selected.workflow.workflowInstanceId,
          reason: run.failure?.message ?? 'execution failed',
        };
        break;
      }
      dispatched.push({ activationId: selected.activation.activationId, runId: run.runId });
      dispatchedIds.add(selected.activation.activationId);
    } catch (error) {
      if (error instanceof DelegationPendingError) {
        isolatedIds.add(selected.workflow.workflowInstanceId);
        stopReason = {
          kind: WorkflowStatus.Waiting,
          workflowInstanceId: selected.workflow.workflowInstanceId,
        };
        continue;
      }
      if (error instanceof ActivationClaimConflictError || error instanceof NoEligibleRunnerError) {
        stopReason = { kind: 'no-work' };
        break;
      }
      if (
        await advancementWasDurablyApplied(
          ctx.orchestration,
          selected.workflow.workflowInstanceId,
          selected.activation.activationId,
        )
      )
        throw error;
      const reason = await blockIsolatedWorkflow(
        ctx.orchestration,
        selected.workflow.workflowInstanceId,
        error,
        ctx.commandContext(selected.activation.activationId),
      );
      isolatedIds.add(selected.workflow.workflowInstanceId);
      isolated = {
        kind: WorkflowStatus.Blocked,
        workflowInstanceId: selected.workflow.workflowInstanceId,
        reason,
      };
    }
  }

  return dispatched.length > 0
    ? { kind: 'progressed', dispatched }
    : (stopReason ?? isolated ?? { kind: 'no-work' });
}
