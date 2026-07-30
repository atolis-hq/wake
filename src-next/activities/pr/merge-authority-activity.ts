import { z } from 'zod';
import type { ActivityDefinition } from '../contracts/activity.js';
import type { PullRequestService } from './application.js';

export function createPullRequestMergeAuthorityActivity(
  service: PullRequestService,
): ActivityDefinition {
  return {
    name: 'pr.merge',
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.enum(['merge-denied', 'merge-authorized']) }).strict(),
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute(invocation, context) {
        const allowed = await service.authorizeMerge(invocation.workItemId, {
          commandId: `${invocation.activationId}:pr.merge`,
          correlationId: invocation.orchestrationGroupId as never,
          occurredAt: context.occurredAt,
          actor: { kind: 'system', id: 'activities-pr' },
        });
        return { kind: allowed ? 'merge-authorized' : 'merge-denied' };
      },
    },
  };
}
