import type { CommandContext } from '@atolis-hq/eventing';
import { RunStatus, type RunView } from '../../execution/index.js';
import {
  DelegationPendingError,
  type ConversationCommandResult,
  type OrchestrationService,
  type WorkflowInstanceView,
} from '../../orchestration/index.js';
import { findUnresolvedTerminal } from './execution-reconciliation.js';
import { isRunnerUnavailableOutcome, runnerUnavailableMessage } from './runner-quota-outcome.js';

/** Both operator surfaces recover from authoritative Run evidence, just as the scheduler does. */
export async function recoverOperatorRun(
  orchestration: OrchestrationService,
  execution: { list(activationId?: string): Promise<readonly RunView[]> },
  workflows: readonly WorkflowInstanceView[],
  context: CommandContext,
): Promise<ConversationCommandResult> {
  const candidates = workflows.flatMap((workflow) =>
    workflow.pendingActivation === undefined
      ? []
      : [{ workflow, activation: workflow.pendingActivation }],
  );
  const recovery = await findUnresolvedTerminal(candidates, execution);
  if (recovery === undefined)
    return {
      applied: false,
      reason:
        'No retry-eligible failed stage or unrouted terminal run. To continue eligible blocked agent work, use /changes followed by instructions.',
    };
  const { item, run } = recovery;
  try {
    await applyTerminalRecovery(orchestration, item, run, context);
  } catch (error) {
    if (error instanceof DelegationPendingError)
      return {
        applied: false,
        reason:
          'The terminal run is retained by the delegation gate; only a quota-stopped attention activation can be re-requested while held.',
      };
    throw error;
  }
  const updated = await orchestration.get(item.workflow.workflowInstanceId);
  return updated?.acceptedOutcomes.includes(item.activation.activationId)
    ? { applied: true }
    : {
        applied: false,
        reason: 'The terminal run could not be recovered; its outcome remains unrouted.',
      };
}

async function applyTerminalRecovery(
  orchestration: OrchestrationService,
  item: {
    workflow: WorkflowInstanceView;
    activation: NonNullable<WorkflowInstanceView['pendingActivation']>;
  },
  run: RunView,
  context: CommandContext,
): Promise<void> {
  if (run.status === RunStatus.Succeeded && run.outcome !== undefined) {
    if (isRunnerUnavailableOutcome(run.outcome)) {
      await orchestration.retryRunnerQuotaFailure(
        item.workflow.workflowInstanceId,
        {
          activationId: item.activation.activationId,
          runId: run.runId,
          runnerName: run.runner?.name ?? 'unknown-runner',
          message: runnerUnavailableMessage(run.outcome),
        },
        context,
      );
    } else {
      await orchestration.acceptOutcome(
        {
          workflowInstanceId: item.workflow.workflowInstanceId,
          activationId: item.activation.activationId,
          outcome: run.outcome,
        },
        context,
      );
    }
  } else {
    await orchestration.resolveExecutionFailure(
      item.workflow.workflowInstanceId,
      {
        activationId: item.activation.activationId,
        runId: run.runId,
        reason: run.failure?.message ?? 'execution failed',
        ...(run.failure === undefined ? {} : { failureKind: run.failure.kind }),
      },
      context,
    );
  }
}
