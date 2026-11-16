import { expect, it } from 'vitest';
import { deliveryReadyRequirements } from '../../../src/integrations/application/delegation-output-review.js';

it.each(['missing-verdict', 'unaccepted-run', 'wrong-head', 'base-assignment'])(
  'explains exact-head review readiness (%s)',
  async (scenario) => {
    let reason: string | undefined;
    const review =
      scenario === 'missing-verdict'
        ? undefined
        : {
            workflowInstanceId: 'review',
            parentWorkflowInstanceId: 'child',
            acceptedOutcomes: scenario === 'unaccepted-run' ? [] : ['accepted'],
          };
    const selected = await deliveryReadyRequirements(
      {
        reviewPolicy: async () => ({ requireApproval: false, review }),
        blocked: (value: string) => {
          reason = value;
        },
        runs: async () => [
          {
            workflowInstanceId: 'review',
            activationId: 'accepted',
            status: 'succeeded',
            workspace: { mode: 'read-only' },
            repositoryAssignment: { sourceRevision: 'base' },
            workspaceRevision: scenario === 'wrong-head' ? 'old' : 'head',
            outcome: { kind: 'done' },
          },
        ],
      } as never,
      { workflowInstanceId: 'child' } as never,
      'head',
    );
    if (scenario === 'base-assignment') {
      expect(selected).toEqual({ requireReview: false, requireChecks: true });
      expect(reason).toBeUndefined();
    } else {
      expect(selected).toBeNull();
      expect(reason).toContain(scenario === 'wrong-head' ? 'exact head head' : 'No accepted');
    }
  },
);
