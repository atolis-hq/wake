import {
  ActivityFailureCode,
  ActivityOutcomeKind,
  ActivityRunnerTransportStatus,
} from '../contracts/vocabulary.js';
import type {
  ActivityHandler,
  ActivityInvocation,
  AgentRunnerPort,
} from '../contracts/activity.js';
import { translateAgentResult, type AgentActivityOutcome } from './agent-result.js';

export interface AgentTemplateRenderer {
  render(
    name: string,
    context: { readonly workItemId: string },
  ): Promise<{
    readonly prompt: string;
    readonly model?: string | null | undefined;
    readonly allowedTools?: readonly string[] | null | undefined;
    readonly maxTurns?: number | undefined;
  }>;
}

export function createAgentActivity(templates?: AgentTemplateRenderer): ActivityHandler<
  {
    prompt?: string;
    template?: string;
    model?: string;
    allowedTools?: readonly string[];
  },
  AgentActivityOutcome
> {
  return {
    async execute(invocation, context): Promise<AgentActivityOutcome> {
      if (context.runner === undefined)
        throw new Error('Agent Activity requires a runner resolved by Execution');
      const request = await agentRequest(invocation, templates);
      const execution = await context.runner.start(request, context.signal);
      if (execution.identity !== undefined)
        await context.reportExternalExecution(execution.identity);
      const result = await execution.result;
      await context.reportRunnerResult?.({ ...result, runner: result.runner ?? 'unknown-runner' });
      return agentOutcome(result);
    },
  };
}

async function agentRequest(
  invocation: ActivityInvocation<{
    prompt?: string;
    template?: string;
    model?: string;
    allowedTools?: readonly string[];
  }>,
  templates: AgentTemplateRenderer | undefined,
) {
  const input = invocation.input;
  const template = await resolveTemplate(input.template, invocation.workItemId, templates);
  return requestFrom(input, invocation.activationId, template);
}

async function resolveTemplate(
  name: string | undefined,
  workItemId: string,
  templates: AgentTemplateRenderer | undefined,
) {
  if (name === undefined) return undefined;
  const template = await templates?.render(name, { workItemId });
  if (template === undefined)
    throw new Error('Agent Activity template rendering is not configured');
  return template;
}

function requestFrom(
  input: { prompt?: string; model?: string; allowedTools?: readonly string[] },
  runId: string,
  template:
    | {
        readonly prompt: string;
        readonly model?: string | null | undefined;
        readonly allowedTools?: readonly string[] | null | undefined;
        readonly maxTurns?: number | undefined;
      }
    | undefined,
) {
  const model = input.model ?? template?.model;
  return {
    runId,
    prompt: input.prompt ?? template!.prompt,
    ...(model === undefined || model === null ? {} : { model }),
    allowedTools: input.allowedTools ?? template?.allowedTools ?? [],
    ...(template?.maxTurns === undefined ? {} : { maxTurns: template.maxTurns }),
  };
}

function agentOutcome(
  result: Awaited<Awaited<ReturnType<AgentRunnerPort['start']>>['result']>,
): AgentActivityOutcome {
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
}

function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return { status: output.trim() };
  }
}
