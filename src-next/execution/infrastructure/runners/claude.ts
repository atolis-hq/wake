import { ExternalExecutionKind } from '../../../activities/index.js';
import type {
  AgentRunnerResult,
  Runner,
  RunnerExecution,
  RunnerRequest,
} from '../../contracts/runner.js';
import { ExecutionCancellationReason, RunStatus } from '../../contracts/vocabulary.js';
import { runProcess } from '../process-execution.js';

export function createClaudeRunner(
  command = 'claude',
  timeoutMs?: number,
  passthroughArgs: readonly string[] = [],
): Runner {
  return cliRunner('claude', command, (request) => claudeCommandArgs(request, passthroughArgs), {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    parseSuccessfulOutput: parseClaudeOutput,
  });
}

export function parseClaudeOutput(stdout: string): Partial<AgentRunnerResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return {};
  }
  const value = record(parsed);
  if (value === undefined) return {};
  if (typeof value.result !== 'string') return {};
  const usage = record(value.usage);
  const input = usage === undefined ? undefined : numeric(usage.input_tokens);
  const output = usage === undefined ? undefined : numeric(usage.output_tokens);
  const cacheRead = usage === undefined ? undefined : numeric(usage.cache_read_input_tokens);
  const cacheWrite = usage === undefined ? undefined : numeric(usage.cache_creation_input_tokens);
  const costUsd = numeric(value.total_cost_usd);
  return {
    output: value.result,
    ...(typeof value.session_id === 'string' ? { sessionId: value.session_id } : {}),
    ...(input === undefined || output === undefined
      ? {}
      : {
          tokenUsage: {
            input,
            output,
            ...(cacheRead === undefined ? {} : { cacheRead }),
            ...(cacheWrite === undefined ? {} : { cacheWrite }),
            ...(costUsd === undefined ? {} : { costUsd }),
          },
        }),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function claudeCommandArgs(
  request: RunnerRequest,
  passthroughArgs: readonly string[] = [],
): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    ...(request.resumeSessionId === undefined ? [] : ['--resume', request.resumeSessionId]),
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...(request.maxTurns === undefined ? [] : ['--max-turns', String(request.maxTurns)]),
    ...(request.allowedTools.length === 0
      ? []
      : ['--allowedTools', request.allowedTools.join(' ')]),
    ...passthroughArgs,
    '--',
    request.prompt,
  ];
}

export function cliRunner(
  name: string,
  command: string,
  args: (request: RunnerRequest) => string[],
  options: {
    readonly timeoutMs?: number;
    readonly parseSuccessfulOutput?: (stdout: string) => Partial<AgentRunnerResult>;
  } = {},
): Runner {
  return {
    async start(request, signal): Promise<RunnerExecution> {
      const process = runProcess(
        command,
        args(request),
        request.workspacePath,
        signal,
        options.timeoutMs,
      );
      return {
        identity: {
          kind: ExternalExecutionKind.Process,
          id: request.runId,
          startedAt: new Date().toISOString(),
        },
        result: process.result.then((value): AgentRunnerResult =>
          value.exitCode === 0 && !value.timedOut
            ? {
                transport: RunStatus.Succeeded,
                output: value.stdout,
                runner: name,
                ...(request.model === undefined ? {} : { model: request.model }),
                ...parseSuccessfulOutput(value.stdout, options.parseSuccessfulOutput),
              }
            : {
                transport: RunStatus.Failed,
                output: value.stdout,
                runner: name,
                failure: {
                  kind: value.timedOut ? ExecutionCancellationReason.Timeout : 'process-exit',
                  message: value.timedOut
                    ? `Runner timed out after ${options.timeoutMs}ms`
                    : value.stderr || `exit ${value.exitCode}`,
                },
              },
        ),
        cancel: process.cancel,
      };
    },
  };
}

function parseSuccessfulOutput(
  stdout: string,
  parser: ((stdout: string) => Partial<AgentRunnerResult>) | undefined,
): Partial<AgentRunnerResult> {
  if (parser === undefined) return {};
  try {
    return parser(stdout);
  } catch {
    return {};
  }
}
