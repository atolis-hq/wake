import { ExternalExecutionKind } from '../../../activities/index.js';
import type {
  AgentRunnerResult,
  Runner,
  RunnerExecution,
  RunnerRequest,
} from '../../contracts/runner.js';
import { WakeMcpServerName } from '../../contracts/runner.js';
import { ExecutionCancellationReason, RunStatus } from '../../contracts/vocabulary.js';
import {
  runProcess,
  type ProcessStdoutDecoder,
  type ProcessTimeouts,
} from '../process-execution.js';
import {
  classifyClaudeFailure,
  ClaudeNoFinalResultFailureKind,
  parseClaudeOutput,
} from './claude-output.js';
import { createClaudeStreamDecoder } from './claude-stream.js';

export { classifyClaudeFailure, ClaudeNoFinalResultFailureKind, parseClaudeOutput };

export function createClaudeRunner(options: CliRunnerOptions = {}): Runner {
  return cliRunner(
    'claude',
    options.command ?? 'claude',
    (request) => claudeCommandArgs(request, options.args, options),
    {
      ...(options.runnerTimeouts === undefined ? {} : { runnerTimeouts: options.runnerTimeouts }),
      ...(options.model === undefined ? {} : { defaultModel: options.model }),
      parseSuccessfulOutput: parseClaudeOutput,
      unparsedSuccessFailure: {
        kind: ClaudeNoFinalResultFailureKind,
        message: 'Claude exited successfully without a usable final result event',
      },
      createStdoutDecoder: createClaudeStreamDecoder,
      classifyFailure: classifyClaudeFailure,
      supportsSessionResume: true,
      supportsEphemeralMcp: true,
    },
  );
}

// `claude -p` stays alive until a pending wakeup fires, even past its background-wait cap.
// A finished run would hang until Wake's idle timeout kills it and discards the result.
const claudeDisallowedTools = ['ScheduleWakeup'];

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
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(request.resumeSessionId === undefined ? [] : ['--resume', request.resumeSessionId]),
    ...(model === undefined ? [] : ['--model', model]),
    ...(effort === undefined ? [] : ['--effort', effort]),
    ...(request.maxTurns === undefined ? [] : ['--max-turns', String(request.maxTurns)]),
    ...(request.allowedTools.length === 0
      ? []
      : ['--allowedTools', claudeAllowedTools(request).join(' ')]),
    '--disallowedTools',
    claudeDisallowedTools.join(' '),
    ...(request.mcpServers === undefined || request.mcpServers.length === 0
      ? []
      : ['--mcp-config', JSON.stringify(claudeMcpConfig(request)), '--strict-mcp-config']),
    ...passthroughArgs,
    '--',
    request.prompt,
  ];
}

function claudeAllowedTools(request: RunnerRequest): readonly string[] {
  return [
    ...new Set([
      ...request.allowedTools,
      ...(request.mcpServers?.some((server) => server.name === WakeMcpServerName)
        ? [`mcp__${WakeMcpServerName}`]
        : []),
    ]),
  ];
}

function claudeMcpConfig(request: RunnerRequest) {
  return {
    mcpServers: Object.fromEntries(
      (request.mcpServers ?? []).map((server) => [
        server.name,
        {
          command: server.command,
          ...(server.args === undefined ? {} : { args: server.args }),
          ...(server.env === undefined ? {} : { env: server.env }),
        },
      ]),
    ),
  };
}

export function cliRunner(
  name: string,
  command: string,
  args: (request: RunnerRequest) => string[],
  options: {
    readonly runnerTimeouts?: ProcessTimeouts;
    readonly createStdoutDecoder?: () => ProcessStdoutDecoder;
    readonly defaultModel?: string;
    readonly supportsSessionResume?: boolean;
    readonly supportsEphemeralMcp?: boolean;
    // When set, a successful exit whose parser yields no output fails instead of publishing raw stdout.
    readonly unparsedSuccessFailure?: { readonly kind: string; readonly message: string };
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
    supportsEphemeralMcp: options.supportsEphemeralMcp === true,
    async start(request, signal): Promise<RunnerExecution> {
      if (
        request.mcpServers !== undefined &&
        request.mcpServers.length > 0 &&
        !options.supportsEphemeralMcp
      )
        throw new Error(`${name} runner does not support ephemeral MCP configuration`);
      const process = runProcess(command, args(request), request.workspacePath, signal, {
        ...options.runnerTimeouts,
        ...(options.createStdoutDecoder === undefined
          ? {}
          : { stdoutDecoder: options.createStdoutDecoder() }),
        ...(request.onTimeout === undefined ? {} : { onTimeout: request.onTimeout }),
      });
      return {
        identity: {
          kind: ExternalExecutionKind.Process,
          id: process.identity ?? request.runId,
          startedAt: new Date().toISOString(),
        },
        result: process.result.then((value): AgentRunnerResult => {
          if (value.exitCode !== 0 || value.timedOut)
            return {
              transport: RunStatus.Failed,
              output: value.stdout,
              runner: name,
              failure: failureFor(value, options),
            };
          const parsed = parseSuccessfulOutput(
            value.stdout,
            request,
            options.parseSuccessfulOutput,
          );
          if (options.unparsedSuccessFailure !== undefined && parsed.output === undefined)
            return {
              transport: RunStatus.Failed,
              output: '',
              runner: name,
              failure: options.unparsedSuccessFailure,
            };
          return {
            transport: RunStatus.Succeeded,
            output: value.stdout,
            runner: name,
            ...((request.model ?? options.defaultModel) === undefined
              ? {}
              : { model: request.model ?? options.defaultModel }),
            ...parsed,
          };
        }),
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
