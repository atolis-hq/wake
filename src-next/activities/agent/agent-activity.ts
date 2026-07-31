import {
  ActivityFailureCode,
  ActivityOutcomeKind,
  ActivityRunnerTransportStatus,
} from '../contracts/vocabulary.js';
import type { ActivityHandler } from '../contracts/activity.js';
import type {
  ActivityRunnerTransportStatus as ActivityRunnerTransportStatusValue,
  ExternalExecutionKind as ExternalExecutionKindValue,
} from '../contracts/vocabulary.js';
import { translateAgentResult, type AgentActivityOutcome } from './agent-result.js';

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
      readonly kind: ExternalExecutionKindValue;
      readonly id: string;
      readonly startedAt: string;
    };
    readonly result: Promise<{
      readonly transport: ActivityRunnerTransportStatusValue;
      readonly output: string;
      readonly failure?: { readonly kind: string; readonly message: string };
    }>;
  }>;
}

export function createAgentActivity(
  runner: AgentRunner,
): ActivityHandler<
  { prompt: string; model?: string; allowedTools?: readonly string[] },
  AgentActivityOutcome
> {
  return {
    async execute(invocation, context): Promise<AgentActivityOutcome> {
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
