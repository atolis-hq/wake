import { ActivityOutcomeKind } from '../../activities/index.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';

/** Configured terminal completion may follow a custom outcome or a satisfied signal gate. */
export function isSuccessfulWorkflowCompletion(view: WorkflowInstanceView): boolean {
  return (
    view.status === WorkflowStatus.Completed &&
    view.lastOutcome?.kind !== ActivityOutcomeKind.Failed &&
    view.lastOutcome?.kind !== ActivityOutcomeKind.Blocked &&
    view.lastOutcome?.kind !== ActivityOutcomeKind.Rejected
  );
}
