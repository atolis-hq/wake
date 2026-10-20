import {
  ActivityEventType,
  decidePullRequestOutputAuthority,
  type PullRequestService,
} from '../../activities/index.js';
import type { RunView } from '../../execution/index.js';
import type { DeliveryIntegration } from '../../orchestration/index.js';
import { BuiltInResourceKind, resourceId, type ResourceService } from '../../resources/index.js';
import type { ArtifactVerificationResult } from '../contracts/artifact-vocabulary.js';
import type { ProviderInstance, VerifiedArtifact } from '../contracts/provider.js';

export type DeliveryIntegrationVerification = Pick<DeliveryIntegration, 'verifyTarget'>;

/** Reuses provider artifact verification and the target's own current review/check authority. */
export function createDeliveryIntegrationVerification(input: {
  readonly resources: ResourceService;
  readonly pullRequests: PullRequestService;
  readonly runs: () => Promise<readonly RunView[]>;
  readonly providers: () => Promise<readonly ProviderInstance[]>;
}): DeliveryIntegrationVerification {
  return {
    async verifyTarget(request) {
      const resource = await input.resources.get(resourceId(request.resourceId));
      const repository = await input.resources.get(resourceId(request.repositoryResourceId));
      const owner = await input.resources.primaryCorrelation(resourceId(request.resourceId));
      if (resource === null || repository === null || owner?.workItemId !== request.ownerWorkItemId)
        return false;
      const provider = (await input.providers()).find(
        (entry) => entry.adapter === resource.externalKey.adapter,
      );
      if (provider === undefined) return false;
      const verified = await provider.verifyArtifact(
        BuiltInResourceKind.PullRequest,
        resource.externalKey,
        {
          repository: repository.externalKey,
          workspaceBranch: request.branch,
          workspaceRevision: request.revision,
          pullRequestBase: request.pullRequestBase,
        },
      );
      if (!matchesVerifiedTarget(verified, resource.externalKey, request.revision)) return false;
      if (!(await freshEvidence(request, input, resource.resourceId))) return false;
      const decision = decidePullRequestOutputAuthority(
        await input.pullRequests.authorityInput(owner.workItemId),
        {
          target: { resourceId: resource.resourceId },
          requireAcceptedReview: request.requireReview,
          requireChecks: request.requireChecks,
        },
      );
      return decision.allowed && decision.revision.toLowerCase() === request.revision.toLowerCase();
    },
  };
}

async function freshEvidence(
  request: Parameters<DeliveryIntegration['verifyTarget']>[0],
  input: {
    readonly runs: () => Promise<readonly RunView[]>;
    readonly pullRequests: PullRequestService;
  },
  id: Parameters<PullRequestService['factsFor']>[0],
): Promise<boolean> {
  if (request.maintenanceRunId === undefined) return true;
  const run = (await input.runs()).find((entry) => entry.runId === request.maintenanceRunId);
  if (run === undefined) return false;
  if (!(await freshChecks(request, input.pullRequests, id, run))) return false;
  if (!request.requireReview) return true;
  return (await input.pullRequests.factsFor(id)).some(
    ({ event }) =>
      event.eventType === ActivityEventType.ReviewAcceptanceSignalRecorded &&
      event.payload.trusted &&
      event.payload.revision.toLowerCase() === request.revision.toLowerCase() &&
      event.occurredAt >= (run.executionStartedAt ?? run.startedAt),
  );
}

function matchesVerifiedTarget(
  verified: VerifiedArtifact | ArtifactVerificationResult,
  key: VerifiedArtifact['externalKey'],
  revision: string,
): boolean {
  return (
    typeof verified !== 'string' &&
    verified.kind === BuiltInResourceKind.PullRequest &&
    verified.externalKey.adapter === key.adapter &&
    verified.externalKey.key === key.key &&
    verified.revision?.toLowerCase() === revision.toLowerCase()
  );
}

async function freshChecks(
  request: Parameters<DeliveryIntegration['verifyTarget']>[0],
  pullRequests: PullRequestService,
  id: Parameters<PullRequestService['get']>[0],
  run: RunView,
): Promise<boolean> {
  if (!request.requireChecks) return true;
  const view = await pullRequests.get(id);
  const evidence = view?.checkEvidence;
  if (evidence === undefined || request.baseRevision === undefined) return false;
  return (
    evidence.headRevision.toLowerCase() === request.revision.toLowerCase() &&
    evidence.baseRevision.toLowerCase() === request.baseRevision.toLowerCase() &&
    evidence.baseRevision.toLowerCase() === view!.baseRevision.toLowerCase() &&
    Date.parse(evidence.startedAt) >=
      Math.max(
        Date.parse(request.maintenanceRecordedAt ?? run.finishedAt ?? ''),
        Date.parse(run.executionStartedAt ?? run.startedAt),
      )
  );
}
