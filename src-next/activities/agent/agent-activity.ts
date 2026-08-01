import {
  ActivityFailureCode,
  ActivityOutcomeKind,
  ActivityRunnerTransportStatus,
} from '../contracts/vocabulary.js';
import type { ActivityHandler } from '../contracts/activity.js';
import { translateAgentResult, type AgentActivityOutcome } from './agent-result.js';

export function createAgentActivity(): ActivityHandler<
  { prompt: string; model?: string; allowedTools?: readonly string[] },
  AgentActivityOutcome
> {
  return {
    async execute(invocation, context): Promise<AgentActivityOutcome> {
      if (context.runner === undefined)
        throw new Error('Agent Activity requires a runner resolved by Execution');
      const input = invocation.input;
      const execution = await context.runner.start(
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
      if (result.transport === ActivityRunnerTransportStatus.Ambiguous)
        return {
          kind: ActivityOutcomeKind.Blocked,
          data: { reason: ActivityFailureCode.AmbiguousRunnerResult },
        };
      if (result.transport !== ActivityRunnerTransportStatus.Succeeded)
        return {
          kind: ActivityOutcomeKind.Failed,
          data: {
            reason: ActivityFailureCode.RunnerFailed,
            ...(result.failure === undefined ? {} : { message: result.failure.message }),
          },
        };
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
