import type { AgentAction, RunnerSentinel, Stage } from '../domain/types.js';

export function createLifecycleService() {
  return {
    nextStageFromSentinel(
      action: AgentAction,
      sentinel: RunnerSentinel,
    ): Stage {
      if (sentinel === 'BLOCKED') {
        return 'blocked';
      }

      if (sentinel === 'FAILED') {
        return 'failed';
      }

      if (sentinel === 'AWAITING_APPROVAL') {
        return 'awaiting-approval';
      }

      return action === 'refine' ? 'refined' : 'done';
    },
  };
}
