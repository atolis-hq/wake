import { ExternalExecutionKind } from '../../../activities/index.js';
import type {
  AgentRunnerResult,
  Runner,
  RunnerExecution,
  RunnerRequest,
} from '../../contracts/runner.js';
import { ProviderQuotaExceededFailureKind } from '../../contracts/runner.js';
import { ExecutionCancellationReason, RunStatus } from '../../contracts/vocabulary.js';
import { runProcess, type ProcessTimeouts } from '../process-execution.js';

export function createClaudeRunner(options: CliRunnerOptions = {}): Runner {
  return cliRunner(
    'claude',
    options.command ?? 'claude',
    (request) => claudeCommandArgs(request, options.args, options),
    {
      ...(options.runnerTimeouts === undefined ? {} : { runnerTimeouts: options.runnerTimeouts }),
      ...(options.model === undefined ? {} : { defaultModel: options.model }),
      parseSuccessfulOutput: parseClaudeOutput,
      classifyFailure: classifyClaudeFailure,
      supportsSessionResume: true,
    },
  );
}

export function parseClaudeOutput(
  stdout: string,
  _request?: RunnerRequest,
): Partial<AgentRunnerResult> {
  const value = parseRecord(stdout);
  if (value === undefined || typeof value.result !== 'string') return {};
  return {
    output: value.result,
    ...(typeof value.session_id === 'string' ? { sessionId: value.session_id } : {}),
    ...claudeUsage(value),
  };
}

// Deliberately narrow: only genuine provider usage/rate-limit phrasing.
// Auth/login failures (unauthorized, authentication, permission denied, api
// key) are NOT included here — they are a different failure class and must
// not be paused-and-retried as if they were transient.
const claudeQuotaPattern =
  /rate limit|quota|credit balance|spend limit|usage limit|session limit|too many requests|\b429\b/i;

export function classifyClaudeFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly kind: string; readonly message: string } | undefined {
  // Prefer stderr — a CLI's own diagnostic stream — over stdout, which on a
  // failed run can carry the agent's own generated text; only fall back to
  // stdout when stderr is empty.
  const text = input.stderr.trim().length > 0 ? input.stderr : input.stdout;
  if (!claudeQuotaPattern.test(text)) return undefined;
  return { kind: ProviderQuotaExceededFailureKind, message: text.trim() };
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
    readonly runnerTimeouts?: ProcessTimeouts;
    readonly defaultModel?: string;
    readonly supportsSessionResume?: boolean;
    readonly parseSuccessfulOutput?: (
      stdout: string,
      request: RunnerRequest,
    ) => Partial<AgentRunnerResult>;
    readonly classifyFailure?: (input: {
      readonly stdout: string;
      readonly stderr: string;
    }) => { readonly kind: string; readonly message: string } | undefined;
  } = {},
): Runner {
  return {
    supportsSessionResume: options.supportsSessionResume === true,
    async start(request, signal): Promise<RunnerExecution> {
      const process = runProcess(command, args(request), request.workspacePath, signal, {
        ...options.runnerTimeouts,
        ...(request.onTimeout === undefined ? {} : { onTimeout: request.onTimeout }),
      });
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
                ...((request.model ?? options.defaultModel) === undefined
                  ? {}
                  : { model: request.model ?? options.defaultModel }),
                ...parseSuccessfulOutput(value.stdout, request, options.parseSuccessfulOutput),
              }
            : {
                transport: RunStatus.Failed,
                output: value.stdout,
                runner: name,
                failure: failureFor(value, options),
              },
        ),
        cancel: process.cancel,
      };
    },
  };
}

function failureFor(
  value: {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | undefined;
    readonly timedOut: boolean;
    readonly timeoutKind?: 'idle' | 'hard';
    readonly failureKind?: 'output-limit';
    readonly failureMessage?: string;
  },
  options: {
    readonly runnerTimeouts?: ProcessTimeouts;
    readonly classifyFailure?: (input: {
      readonly stdout: string;
      readonly stderr: string;
    }) => { readonly kind: string; readonly message: string } | undefined;
  },
): { readonly kind: string; readonly message: string } {
  if (value.timedOut)
    return {
      kind:
        value.timeoutKind === 'idle'
          ? ExecutionCancellationReason.IdleTimeout
          : ExecutionCancellationReason.Timeout,
      message:
        value.timeoutKind === 'idle'
          ? timeoutMessage('idle', options.runnerTimeouts?.idleMs)
          : timeoutMessage('hard', options.runnerTimeouts?.hardMs),
    };
  if (value.failureKind !== undefined)
    return {
      kind: value.failureKind,
      message: value.failureMessage ?? (value.stderr || `exit ${value.exitCode}`),
    };
  const classified = options.classifyFailure?.({ stdout: value.stdout, stderr: value.stderr });
  if (classified !== undefined) return classified;
  return { kind: 'process-exit', message: value.stderr || `exit ${value.exitCode}` };
}

function timeoutMessage(kind: 'idle' | 'hard', timeoutMs: number | undefined): string {
  if (timeoutMs === undefined)
    return kind === 'idle'
      ? 'Runner exceeded its idle timeout'
      : 'Runner exceeded its hard timeout';
  return kind === 'idle'
    ? `Runner was idle for ${timeoutMs}ms`
    : `Runner exceeded the hard timeout of ${timeoutMs}ms`;
}

export interface RunnerDefaults {
  readonly model?: string;
  readonly effort?: string;
}

export interface CliRunnerOptions extends RunnerDefaults {
  readonly command?: string;
  readonly runnerTimeouts?: ProcessTimeouts;
  readonly args?: readonly string[];
}

function parseSuccessfulOutput(
  stdout: string,
  request: RunnerRequest,
  parser: ((stdout: string, request: RunnerRequest) => Partial<AgentRunnerResult>) | undefined,
): Partial<AgentRunnerResult> {
  if (parser === undefined) return {};
  try {
    return parser(stdout, request);
  } catch {
    return {};
  }
}
