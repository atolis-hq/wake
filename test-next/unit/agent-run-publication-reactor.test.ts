import { expect, it } from 'vitest';
import { AgentRunPublicationReactor } from '../../src-next/integrations/application/agent-run-publication-reactor.js';

it('uses the stage immediately preceding the run activation rather than a later advanced stage', async () => {
  const reactor = new AgentRunPublicationReactor({
    journal: {
      readStream: async () => [
        { eventType: 'orchestration.stage-entered', payload: { stage: 'refine' } },
        {
          eventType: 'orchestration.activity-requested',
          payload: { activationId: 'activation-1' },
        },
        { eventType: 'orchestration.stage-entered', payload: { stage: 'implement' } },
      ],
    },
    checkpoints: {},
    runs: {},
    resources: {},
    orchestration: {},
  } as never);
  await expect(
    (
      reactor as never as {
        stageForActivation: (workflow: string, activation: string) => Promise<string | undefined>;
      }
    ).stageForActivation('workflow-1', 'activation-1'),
  ).resolves.toBe('refine');
});
