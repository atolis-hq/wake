import { z } from 'zod';

import type {
  ActivityDefinition,
  PullRequestMergeAuthorityGate,
} from '../../../src-next/activities/index.js';

export function mergeAuthorityTestActivity(
  gate: PullRequestMergeAuthorityGate,
): ActivityDefinition {
  return {
    name: 'test.pr.merge-authority',
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.enum(['merge-denied', 'merge-authorized']) }).strict(),
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
