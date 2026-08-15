import { ActivityOutcomeKind } from '../../activities/index.js';
import type { AwaitConfig, StageConfig, WorkflowDefinitionConfig } from '../contracts/config.js';
import { ApprovalAuthorityKind } from '../contracts/vocabulary.js';

/**
 * A `done` route with no explicit `await`/`watchGates` requires human
 * approval before advancing by default, since a watchGate is itself an
 * approval-equivalent and an explicit await is already what the author
 * wants. A stage opts out with `requiresApproval: false`.
 */
export function defaultApprovalAwait(
  stage: StageConfig,
  outcomeKind: string,
  route: WorkflowDefinitionConfig['stages'][string]['on'][string],
): AwaitConfig | undefined {
  if (route.await !== undefined) return route.await;
  if (
    outcomeKind !== ActivityOutcomeKind.Done ||
    route.watchGates !== undefined ||
    route.eventTransitions !== undefined ||
    stage.requiresApproval === false
  )
    return undefined;
  return { signal: 'approved', from: [ApprovalAuthorityKind.Human] };
}
