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
    ...(payload.mergeRevision === undefined ? {} : { mergeRevision: payload.mergeRevision }),
    ...(payload.mergeability === undefined ? {} : { mergeability: payload.mergeability }),
    headRevision: payload.headRevision ?? payload.revision,
    baseRevision: payload.baseRevision ?? 'unknown',
    ...(payload.checkEvidence === undefined ? {} : { checkEvidence: payload.checkEvidence }),
    checks: payload.checks ?? 'unknown',
    ...(payload.changedFiles === undefined ? {} : { changedFiles: payload.changedFiles }),
  };
}
