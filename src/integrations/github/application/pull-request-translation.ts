import type { ObservePullRequest } from '../../../activities/index.js';
import type { ResourceId } from '../../../resources/index.js';
import type { WorkItemId } from '../../../work/index.js';
import type { ExternalWorkObservedPayload } from '../contracts/events.js';

export function observePullRequest(
  resourceId: ResourceId,
  workItemId: WorkItemId,
  payload: ExternalWorkObservedPayload,
): ObservePullRequest {
  return {
    resourceId,
    workItemId,
    state: payload.state,
    headRevision: payload.headRevision ?? payload.revision,
    baseRevision: payload.baseRevision ?? 'unknown',
    checks: payload.checks ?? 'unknown',
    ...(payload.changedFiles === undefined ? {} : { changedFiles: payload.changedFiles }),
  };
}
