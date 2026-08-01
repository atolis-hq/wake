import type { AgentRunInput, AgentRunResult } from '../../core/contracts.js';
import { createAgentExecution } from '../../core/live-execution.js';
import { emitRuntimeEvent, runnerRuntimeEvent } from '../runner/runtime-events.js';

export function createFakeRunner(result?: AgentRunResult, options?: { cli?: string }) {
  const runner = {
    async start(input: AgentRunInput) {
      return createAgentExecution(input, (liveInput) => runner.run(liveInput));
    },
    async run(_: AgentRunInput): Promise<AgentRunResult> {
      const cli = options?.cli ?? 'Fake';
      const isCanceled = () => _.cancellationSignal?.aborted === true;
      if (isCanceled()) {
        return {
          result: 'Fake runner canceled\nFAILED',
          model: 'fake',
          cli,
          failureClass: 'infra',
          metadata: { source: 'fake-runner', canceled: true },
        };
      }
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
      if (isCanceled()) {
        return {
          result: 'Fake runner canceled\nFAILED',
          model: 'fake',
          cli,
          failureClass: 'infra',
          metadata: { source: 'fake-runner', canceled: true },
        };
      }
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
  return runner;
}
