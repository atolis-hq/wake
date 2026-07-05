import type { AgentRunResult } from '../../core/contracts.js';
import type { AgentAction, IssueStateRecord, WakeConfig } from '../../domain/types.js';

export function createFakeRunner(result?: AgentRunResult) {
  return {
    async run(_: {
      action: AgentAction;
      issue: IssueStateRecord;
      config: WakeConfig;
    }): Promise<AgentRunResult> {
      return result ?? {
        result: 'Fake runner completed\nDONE',
        session_id: 'fake-session-1',
        metadata: {
          source: 'fake-runner',
        },
      };
    },
  };
}
