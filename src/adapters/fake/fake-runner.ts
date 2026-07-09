import type { AgentRunResult } from '../../core/contracts.js';
import type {
  AgentAction,
  EventEnvelope,
  IssueStateRecord,
  WakeConfig,
} from '../../domain/types.js';

export function createFakeRunner(
  result?: AgentRunResult,
  options?: { cli?: string },
) {
  return {
    async run(_: {
      action: AgentAction;
      projection: IssueStateRecord;
      recentEvents: EventEnvelope[];
      config: WakeConfig;
      runId: string;
      workspacePath?: string;
    }): Promise<AgentRunResult> {
      return result ?? {
        result: [
          'Fake runner completed',
          '',
          '```wake-result',
          '{ "status": "DONE" }',
          '```',
          'DONE',
        ].join('\n'),
        model: 'fake',
        cli: options?.cli ?? 'Fake',
        session_id: 'fake-session-1',
        metadata: {
          source: 'fake-runner',
        },
      };
    },
  };
}
