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

it.each(['done', 'wrong-head', 'failed', 'rejected', 'unaccepted', 'missing'])(
  'refreshes provenance only for a successful exact-head recovery review (%s)',
  async (scenario) => {
    const { refreshedReviewSubject } =
      await import('../../../src/integrations/application/delegation-output-review.js');
    const subject = { name: 'change', reference: { revision: 'new' } };
    const result = await refreshedReviewSubject(
      {
        reviewPolicy: async () => ({
          requireApproval: true,
          refreshedSubject: subject,
          review:
            scenario === 'missing'
              ? undefined
              : {
                  workflowInstanceId: 'review',
                  parentWorkflowInstanceId: 'child',
                  acceptedOutcomes: scenario === 'unaccepted' ? [] : ['activation'],
                },
        }),
        runs: async () => [
          {
            workflowInstanceId: 'review',
            activationId: 'activation',
            status: scenario === 'failed' ? 'failed' : 'succeeded',
            workspace: { mode: 'read-only' },
            workspaceRevision: scenario === 'wrong-head' ? 'old' : 'new',
            outcome: { kind: scenario === 'rejected' ? 'rejected' : 'done' },
          },
        ],
      } as never,
      { workflowInstanceId: 'child' } as never,
    );
    expect(result).toEqual(scenario === 'done' ? subject : undefined);
  },
);
