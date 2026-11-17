import { RunStatus, type RunView } from '../../execution/index.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../../orchestration/index.js';
import { isRunnerQuotaOutcome } from './runner-quota-outcome.js';

interface ExecutionRunLookup {
  list(activationId?: ActivityActivationView['activationId']): Promise<readonly RunView[]>;
}

/** Held work only recovers a quota stop; routing or blocking on other results stays gated. */
export function isHeldRecoverable(run: RunView): boolean {
  return (
    run.status === RunStatus.Succeeded &&
    run.outcome !== undefined &&
    isRunnerQuotaOutcome(run.outcome)
  );
}

/** Pending activations the delegation gate hides, minus frozen or deleted work. */
export async function heldRecoveryCandidates(
  orchestration: {
    listRecoverableActivations?(
      workItemId?: string,
    ): Promise<readonly { workflow: WorkflowInstanceView; activation: ActivityActivationView }[]>;
  },
  workItemId: string | undefined,
  gated: readonly { activation: ActivityActivationView }[],
  snapshot: () => Promise<
    { get(id: string): { frozen?: boolean; deleted?: boolean } | null | undefined } | undefined
  >,
) {
  const all = (await orchestration.listRecoverableActivations?.(workItemId)) ?? [];
  const gatedIds = new Set(gated.map((item) => item.activation.activationId));
  // Only the cohort's attention activation is recoverable while held; its run is not the delegating run.
  const hidden = all.filter(
    (item) =>
      !gatedIds.has(item.activation.activationId) &&
      item.workflow.delegationAttention?.activationId === item.activation.activationId,
  );
  if (hidden.length === 0) return [];
  const delivery = await snapshot();
  return hidden.filter((item) => {
    const work = delivery?.get(item.workflow.workItemId);
    return !work?.frozen && !work?.deleted;
  });
}

export async function findUnresolvedTerminal(
  pending: readonly { workflow: WorkflowInstanceView; activation: ActivityActivationView }[],
  execution: ExecutionRunLookup,
  accept: (run: RunView) => boolean = () => true,
): Promise<{ item: (typeof pending)[number]; run: RunView } | undefined> {
  for (const item of pending) {
    const run = (await execution.list(item.activation.activationId)).find(
      (candidate) =>
        ((candidate.status === RunStatus.Succeeded && candidate.outcome !== undefined) ||
          isExecutionFailureTerminal(candidate.status)) &&
        accept(candidate),
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
  return status === RunStatus.Failed || status === RunStatus.Cancelled;
}
