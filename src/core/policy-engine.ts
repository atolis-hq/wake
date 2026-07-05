import type { AgentAction, Stage } from '../domain/types.js';

export function createPolicyEngine() {
  return {
    chooseAction(stage: Stage): AgentAction | null {
      if (stage === 'queue') {
        return 'refine';
      }

      if (stage === 'refined') {
        return 'implement';
      }

      return null;
    },
  };
}
