import type { AgentAction, RunnerSentinel, Stage } from '../domain/types.js';

export function createLifecycleService() {
  return {
    // Returns null when the sentinel indicates execution failure rather than a
    // lifecycle transition — the stage should remain unchanged so the next tick
    // can retry from the same point.
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
