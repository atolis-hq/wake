import { PullRequestDenialCode, type ParentOutputTarget } from '../../activities/index.js';
import { IntegrationState } from '../contracts/vocabulary.js';
import type { IntegrationAssessment, IntegrationTarget } from './delivery-integration.js';

/** Multiple outputs of one child have no implicit integration order. */
export function selectIntegrationTarget(
  assessment: IntegrationAssessment,
  output: ParentOutputTarget | undefined,
): { readonly target: IntegrationTarget } | { readonly reason: PullRequestDenialCode } {
  if (output === undefined) {
    const owners = assessment.targets.map((target) => target.output.childWorkItemId);
    if (new Set(owners).size !== owners.length)
      return { reason: PullRequestDenialCode.AmbiguousResource };
    return assessment.next === null
      ? { reason: blockReason(assessment.blocking) }
      : { target: assessment.next };
  }
  const matches = assessment.targets.filter(
    (entry) =>
      (output.childWorkItemId === undefined ||
        entry.output.childWorkItemId === output.childWorkItemId) &&
      entry.output.outputName === output.outputName,
  );
  if (matches.length > 1) return { reason: PullRequestDenialCode.AmbiguousResource };
  const target = matches[0];
  if (target === undefined) return { reason: PullRequestDenialCode.MissingResource };
  return target.state === IntegrationState.Ready ? { target } : { reason: blockReason(target) };
}

function blockReason(blocking: IntegrationAssessment['blocking']): PullRequestDenialCode {
  switch (blocking?.state) {
    case IntegrationState.Held:
      return PullRequestDenialCode.TargetHeld;
    case IntegrationState.MaintenanceRequired:
    case IntegrationState.AwaitingLowerLayer:
      return PullRequestDenialCode.MaintenanceRequired;
    case IntegrationState.Closed:
      return PullRequestDenialCode.Closed;
    case IntegrationState.Unobserved:
      return PullRequestDenialCode.MissingResource;
    default:
      return PullRequestDenialCode.DeliveryNotReady;
  }
}
