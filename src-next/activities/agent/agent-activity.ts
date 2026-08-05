import type {
  ActivityHandler,
  ActivityInvocation,
  AgentRunnerPort,
} from '../contracts/activity.js';
import {
  ActivityFailureCode,
  ActivityOutcomeKind,
  ActivityRunnerTransportStatus,
} from '../contracts/vocabulary.js';
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
      const request = await agentRequest(invocation, templates, context.runnerContext);
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
  runnerContext: { readonly runnerName: string; readonly activationOrdinal: number } | undefined,
) {
  const input = invocation.input;
  const template = await resolveTemplate(input.template, invocation.workItemId, templates);
  return requestFrom(input, invocation.activationId, template, runnerContext);
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

type AgentTemplate =
  | {
      readonly prompt: string;
      readonly model?: string | null | undefined;
      readonly allowedTools?: readonly string[] | null | undefined;
      readonly maxTurns?: number | undefined;
    }
  | undefined;

function requestFrom(
  input: { prompt?: string; template?: string; model?: string; allowedTools?: readonly string[] },
  runId: string,
  template: AgentTemplate,
  runnerContext: { readonly runnerName: string; readonly activationOrdinal: number } | undefined,
) {
  return {
    runId,
    prompt: input.prompt ?? template!.prompt,
    ...modelField(input.model ?? template?.model),
    allowedTools: input.allowedTools ?? template?.allowedTools ?? [],
    ...maxTurnsField(template?.maxTurns),
    ...contextField(runnerContext, input.template),
  };
}

function modelField(model: string | null | undefined) {
  return model === undefined || model === null ? {} : { model };
}

function maxTurnsField(maxTurns: number | undefined) {
  return maxTurns === undefined ? {} : { maxTurns };
}

function contextField(
  runnerContext: { readonly runnerName: string; readonly activationOrdinal: number } | undefined,
  templateName: string | undefined,
) {
  if (runnerContext === undefined) return {};
  return { context: { ...runnerContext, action: templateName ?? 'prompt' } };
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
