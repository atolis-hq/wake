import type { AgentAction, RunnerSentinel, Stage } from '../domain/types.js';

export function createLifecycleService() {
  return {
    nextStageFromSentinel(
      action: AgentAction,
      sentinel: RunnerSentinel,
    ): Stage | null {
      if (sentinel === 'BLOCKED') {
        return 'blocked';
      }

      if (sentinel === 'FAILED') {
        return null;
      }

      if (sentinel === 'AWAITING_APPROVAL') {
        return 'awaiting-approval';
      }

      return action === 'refine' ? 'refined' : 'done';
    },
  };
}
