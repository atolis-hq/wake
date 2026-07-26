import type { AgentRunResult } from '../../core/contracts.js';
import type {
  AgentAction,
  EventEnvelope,
  IssueStateRecord,
  RunnerRouting,
  RuntimeEventDraft,
  WakeConfig,
} from '../../domain/types.js';
import { emitRuntimeEvent, runnerRuntimeEvent } from '../runner/runtime-events.js';

export function createFakeRunner(result?: AgentRunResult, options?: { cli?: string }) {
  return {
    async run(_: {
      action: AgentAction;
      projection: IssueStateRecord;
      recentEvents: EventEnvelope[];
      config: WakeConfig;
      runId: string;
      workspacePath?: string;
      mergeConflictDetected?: boolean;
      onRuntimeEvent?: (event: RuntimeEventDraft) => Promise<void>;
      routing?: RunnerRouting;
    }): Promise<AgentRunResult> {
      const cli = options?.cli ?? 'Fake';
      await emitRuntimeEvent(
        _.onRuntimeEvent,
        runnerRuntimeEvent({
          type: 'agent.process.started',
          runId: _.runId,
          projection: _.projection,
          routing: _.routing,
          cli,
          model: 'fake',
          payload: { synthetic: true },
        }),
      );
      await emitRuntimeEvent(
        _.onRuntimeEvent,
        runnerRuntimeEvent({
          type: 'agent.progress',
          runId: _.runId,
          projection: _.projection,
          routing: _.routing,
          cli,
          model: 'fake',
          sessionId: 'fake-session-1',
          payload: { message: 'Fake runner completed', synthetic: true },
        }),
      );
      await emitRuntimeEvent(
        _.onRuntimeEvent,
        runnerRuntimeEvent({
          type: 'agent.process.exited',
          runId: _.runId,
          projection: _.projection,
          routing: _.routing,
          cli,
          model: 'fake',
          sessionId: 'fake-session-1',
          payload: { exitCode: 0, synthetic: true },
        }),
      );
      return (
        result ?? {
          result: [
            'Fake runner completed',
            '',
            '```wake-result',
            '{ "status": "DONE" }',
            '```',
            'DONE',
          ].join('\n'),
          model: 'fake',
          cli,
          session_id: 'fake-session-1',
          metadata: {
            source: 'fake-runner',
          },
        }
      );
    },
  };
}
