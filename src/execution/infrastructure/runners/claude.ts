import { ExternalExecutionKind } from '../../../activities/index.js';
import type {
  AgentRunnerResult,
  Runner,
  RunnerExecution,
  RunnerRequest,
} from '../../contracts/runner.js';
import { ExecutionCancellationReason, RunStatus } from '../../contracts/vocabulary.js';
import { runProcess } from '../process-execution.js';

export function createClaudeRunner(options: CliRunnerOptions = {}): Runner {
  return cliRunner('claude', options.command ?? 'claude', (request) => claudeCommandArgs(request, options.args, options), {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.model === undefined ? {} : { defaultModel: options.model }),
    parseSuccessfulOutput: parseClaudeOutput,
  });
}

export function parseClaudeOutput(stdout: string): Partial<AgentRunnerResult> {
  const value = parseRecord(stdout);
  if (value === undefined || typeof value.result !== 'string') return {};
  return {
    output: value.result,
    ...(typeof value.session_id === 'string' ? { sessionId: value.session_id } : {}),
    ...claudeUsage(value),
  };
}

function claudeUsage(value: Record<string, unknown>): Partial<AgentRunnerResult> {
  const usage = record(value.usage);
  const input = usage === undefined ? undefined : numeric(usage.input_tokens);
  const output = usage === undefined ? undefined : numeric(usage.output_tokens);
  if (usage === undefined || input === undefined || output === undefined) return {};
  const cacheRead = numeric(usage.cache_read_input_tokens);
  const cacheWrite = numeric(usage.cache_creation_input_tokens);
  const costUsd = numeric(value.total_cost_usd);
  return {
    tokenUsage: {
      input,
      output,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
      ...(costUsd === undefined ? {} : { costUsd }),
    },
  };
}

function parseRecord(stdout: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(stdout) as unknown);
  } catch {
    return undefined;
  }
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
  defaults: RunnerDefaults = {},
): string[] {
  const model = request.model ?? defaults.model;
  const effort = request.effort ?? defaults.effort;
  return [
    '-p',
    '--output-format',
    'json',
    ...(request.resumeSessionId === undefined ? [] : ['--resume', request.resumeSessionId]),
    ...(model === undefined ? [] : ['--model', model]),
    ...(effort === undefined ? [] : ['--effort', effort]),
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
    readonly defaultModel?: string;
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
                ...(request.model ?? options.defaultModel) === undefined
                  ? {}
                  : { model: request.model ?? options.defaultModel },
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

export interface RunnerDefaults {
  readonly model?: string;
  readonly effort?: string;
}

export interface CliRunnerOptions extends RunnerDefaults {
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly args?: readonly string[];
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
