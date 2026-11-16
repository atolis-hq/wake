import { DelegationConflictError } from '../contracts/delegation.js';
import { DelegationConflictCode, WorkflowStatus } from '../contracts/vocabulary.js';

/** Absence proves eligibility only with durable unsuccessful cohort settlement. */
export function assertReplacementState(
  status: WorkflowStatus | undefined,
  unsuccessfullySettled: boolean,
  hasUnresolvedRuns: boolean,
): void {
  const reject = (message: string): never => {
    throw new DelegationConflictError(DelegationConflictCode.ReplacementUnsupported, message);
  };
  if (status === undefined && !unsuccessfullySettled)
    reject(
      'The child workflow instance is missing; replacement requires an unsuccessfully settled cohort',
    );
  if (
    status !== undefined &&
    status !== WorkflowStatus.Completed &&
    status !== WorkflowStatus.Superseded
  )
    reject(
      'Correcting a child that is still running is not supported; replace it once it is complete or superseded',
    );
  if (hasUnresolvedRuns)
    reject('The child has an unresolved run; reconcile it before submitting replacement work');
}
