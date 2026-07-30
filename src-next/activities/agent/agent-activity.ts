import type { ActivityHandler, ActivityOutcome } from '../contracts/activity.js';
import { translateAgentResult } from './agent-result.js';

interface AgentRunner {
  start(
    request: {
      readonly runId: string;
      readonly prompt: string;
      readonly model?: string;
      readonly allowedTools: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<{
    readonly identity?: {
      readonly kind: 'process' | 'remote-session';
      readonly id: string;
      readonly startedAt: string;
    };
    readonly result: Promise<{
      readonly transport: 'succeeded' | 'failed' | 'cancelled' | 'ambiguous';
      readonly output: string;
      readonly failure?: { readonly kind: string; readonly message: string };
    }>;
  }>;
}

export function createAgentActivity(
  runner: AgentRunner,
): ActivityHandler<{ prompt: string; model?: string; allowedTools?: readonly string[] }> {
  return {
    async execute(invocation, context): Promise<ActivityOutcome> {
      const input = invocation.input;
      const execution = await runner.start(
        {
          runId: invocation.activationId,
          prompt: input.prompt,
          ...(input.model === undefined ? {} : { model: input.model }),
          allowedTools: input.allowedTools ?? [],
        },
        context.signal,
      );
      if (execution.identity !== undefined)
        await context.reportExternalExecution(execution.identity);
      const result = await execution.result;
      if (result.transport === 'ambiguous')
        return { kind: 'blocked', data: { reason: 'ambiguous-runner-result' } };
      if (result.transport !== 'succeeded')
        return { kind: 'failed', data: result.failure ?? { reason: 'runner-failed' } };
      return translateAgentResult(parseOutput(result.output));
    },
  };
}

function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return { status: output.trim() };
  }
}
