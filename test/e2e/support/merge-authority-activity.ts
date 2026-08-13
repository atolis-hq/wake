import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';

import type {
  ActivityDefinition,
  PullRequestMergeAuthorityGate,
} from '../../../src/activities/index.js';

export function mergeAuthorityTestActivity(
  gate: PullRequestMergeAuthorityGate,
): ActivityDefinition {
  return {
    name: activityName('test.pr.merge-authority'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.enum(['merge-denied', 'merge-authorized']) }).strict(),
    outcomeKinds: ['merge-denied', 'merge-authorized'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      execute(invocation, context) {
        return gate.evaluate(
          {
            activationId: invocation.activationId,
            orchestrationGroupId: invocation.orchestrationGroupId,
            workItemId: invocation.workItemId,
          },
          context.occurredAt,
        );
      },
    },
  };
}
