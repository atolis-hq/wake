import { ResourceCorrelationRole, type ResourceCapability } from '../../resources/index.js';
import type { ActivityInvocation } from '../contracts/activity.js';
import { resolvePrimaryCapability } from './activity-support.js';
import { isPullRequestLikeResource } from './capability.js';
import type { PullRequestAuthorityInput, PullRequestTarget } from './contracts.js';
import type {
  ParentActionAuthorizer,
  ParentActionDecision,
  ParentActionKind,
} from './parent-scope.js';
import { PullRequestDenialCode } from './vocabulary.js';

export type ParentTarget =
  | { readonly kind: 'unscoped' }
  | Extract<ParentActionDecision, { readonly kind: 'target' | 'fully-integrated' | 'denied' }>;

/**
 * Resolves the one target a parent delivery may act on. Without a port, or when the caller is
 * not a validated delivery parent, the request is denied rather than falling back to the
 * invoking WorkItem: a scoped input never widens into generic cross-WorkItem invocation.
 */
export async function resolveParentTarget(
  authorizer: ParentActionAuthorizer | undefined,
  invocation: Pick<ActivityInvocation, 'workflowInstanceId' | 'activationId'>,
  scoped: boolean,
  action: ParentActionKind,
): Promise<ParentTarget> {
  if (!scoped) return { kind: 'unscoped' };
  if (authorizer === undefined)
    return { kind: 'denied', reason: PullRequestDenialCode.OutsideDelivery };
  return authorizer.authorize({
    workflowInstanceId: invocation.workflowInstanceId,
    activationId: invocation.activationId,
    action,
  });
}

/** The pull request an action applies to: the parent's scoped target, or the WorkItem's own primary. */
export function resolveActionResource(
  parentTarget: ParentTarget,
  authority: PullRequestAuthorityInput,
  invocation: Pick<ActivityInvocation, 'resources' | 'workItemId'>,
  target: PullRequestTarget,
  capability: ResourceCapability,
) {
  const denial = scopedDenialReason(parentTarget, authority, capability);
  if (denial !== undefined) return { allowed: false, reason: denial, candidates: [] } as const;
  if (parentTarget.kind === 'target')
    return { allowed: true, resourceId: parentTarget.resourceId } as const;
  return resolvePrimaryCapability(
    invocation.resources,
    authority,
    invocation.workItemId,
    target,
    capability,
  );
}

/** The reason a scoped request cannot proceed, or undefined when it is allowed or unscoped. */
export function scopedDenialReason(
  parentTarget: ParentTarget,
  authority: PullRequestAuthorityInput,
  capability: ResourceCapability,
): PullRequestDenialCode | undefined {
  if (parentTarget.kind === 'denied') return parentTarget.reason;
  if (parentTarget.kind !== 'target') return undefined;
  const check = checkScopedTarget(authority, parentTarget, capability);
  return check.allowed ? undefined : check.reason;
}

type ScopedCapability =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | typeof PullRequestDenialCode.MissingResource
        | typeof PullRequestDenialCode.StaleApproval
        | typeof PullRequestDenialCode.CorrelationConflict;
    };

/**
 * The scoped target must still be the owner's single primary pull request, carry the concrete
 * capability the action needs, and sit at exactly the revision the parent decided on.
 */
export function checkScopedTarget(
  authority: PullRequestAuthorityInput,
  target: Extract<ParentTarget, { readonly kind: 'target' }>,
  capability: ResourceCapability,
): ScopedCapability {
  const entry = authority.resources.find(
    (candidate) =>
      candidate.resource.resourceId === target.resourceId &&
      isPullRequestLikeResource(candidate.resource.capabilities),
  );
  if (entry === undefined || !entry.resource.capabilities.includes(capability))
    return { allowed: false, reason: PullRequestDenialCode.MissingResource };
  const primary = entry.correlations.filter(
    (correlation) => correlation.role === ResourceCorrelationRole.Primary,
  );
  if (
    entry.resource.primaryCorrelationConflict !== undefined ||
    primary.length !== 1 ||
    primary[0]!.workItemId !== target.context.ownerWorkItemId
  )
    return { allowed: false, reason: PullRequestDenialCode.CorrelationConflict };
  const view = authority.pullRequests.find(
    (candidate) => candidate.resourceId === target.resourceId,
  );
  if (view === undefined) return { allowed: false, reason: PullRequestDenialCode.MissingResource };
  return view.headRevision.toLowerCase() === target.revision.toLowerCase()
    ? { allowed: true }
    : { allowed: false, reason: PullRequestDenialCode.StaleApproval };
}
