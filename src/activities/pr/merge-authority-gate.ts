import { EventActorKind } from '@atolis-hq/eventing';
import type { WorkItemId } from '../../work/index.js';
import type { PullRequestService } from './application.js';

export interface PullRequestMergeAuthorityGateInput {
  readonly activationId: string;
  readonly orchestrationGroupId: string;
  readonly workItemId: WorkItemId;
}

export interface PullRequestMergeAuthorityGate {
  evaluate(
    input: PullRequestMergeAuthorityGateInput,
    occurredAt: string,
  ): Promise<{ readonly kind: 'merge-denied' | 'merge-authorized' }>;
}

export function createPullRequestMergeAuthorityGate(
  service: PullRequestService,
): PullRequestMergeAuthorityGate {
  return {
    async evaluate(input, occurredAt) {
      const allowed = await service.authorizeMerge(input.workItemId, {
        commandId: `${input.activationId}:pr.merge`,
        correlationId: input.orchestrationGroupId as never,
        occurredAt,
        actor: { kind: EventActorKind.System, id: 'activities-pr' },
      });
      return { kind: allowed ? 'merge-authorized' : 'merge-denied' };
    },
  };
}
