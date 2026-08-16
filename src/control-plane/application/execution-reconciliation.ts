import { RunStatus, type RunView } from '../../execution/index.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../../orchestration/index.js';

interface ExecutionRunLookup {
  list(activationId?: ActivityActivationView['activationId']): Promise<readonly RunView[]>;
}

export async function findUnresolvedTerminal(
  pending: readonly { workflow: WorkflowInstanceView; activation: ActivityActivationView }[],
  execution: ExecutionRunLookup,
): Promise<{ item: (typeof pending)[number]; run: RunView } | undefined> {
  for (const item of pending) {
    const run = (await execution.list(item.activation.activationId)).find(
      (candidate) =>
        (candidate.status === RunStatus.Succeeded && candidate.outcome !== undefined) ||
        isExecutionFailureTerminal(candidate.status),
    );
    if (run !== undefined && !item.workflow.acceptedOutcomes.includes(item.activation.activationId))
      return { item, run };
  }
  return undefined;
}

export async function findUnresolvedSucceededTerminal(
  pending: readonly { workflow: WorkflowInstanceView; activation: ActivityActivationView }[],
  execution: ExecutionRunLookup,
): Promise<{ item: (typeof pending)[number]; run: RunView } | undefined> {
  for (const item of pending) {
    const run = (await execution.list(item.activation.activationId)).find(
      (candidate) => candidate.status === RunStatus.Succeeded && candidate.outcome !== undefined,
    );
    if (run !== undefined && !item.workflow.acceptedOutcomes.includes(item.activation.activationId))
      return { item, run };
  }
  return undefined;
}

export function isExecutionFailureTerminal(status: RunStatus): boolean {
  return (
    status === RunStatus.Failed || status === RunStatus.Cancelled || status === RunStatus.Ambiguous
  );
}
