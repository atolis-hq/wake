import type { CommandContext } from '@atolis-hq/eventing';
import type { ActivityActivationView, WorkflowInstanceView } from '../../orchestration/index.js';
import type { OrchestrationPort } from './activation-scheduler-ports.js';

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
