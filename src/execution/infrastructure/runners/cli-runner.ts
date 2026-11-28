import { ExternalExecutionKind } from '../../../activities/index.js';
import type {
  AgentRunnerResult,
  Runner,
  RunnerExecution,
  RunnerRequest,
} from '../../contracts/runner.js';
import { ExecutionCancellationReason, RunStatus } from '../../contracts/vocabulary.js';
import {
  runProcess,
  type ProcessExecutionOptions,
  type ProcessExecutionResult,
  type ProcessStdoutDecoder,
  type ProcessTimeouts,
} from '../process-execution.js';

type RunnerFailureDetail = { readonly kind: string; readonly message: string };

/**
 * `Context` is per-invocation state (for example a temp file path) created by
 * `prepare`, handed to the argument builder and result hooks, and released by
 * `cleanup`.
 */
export interface CliRunnerBehaviour<Context = undefined> {
  readonly runnerTimeouts?: ProcessTimeouts;
  readonly createStdoutDecoder?: () => ProcessStdoutDecoder;
  readonly defaultModel?: string;
  readonly supportsSessionResume?: boolean;
  readonly supportsEphemeralMcp?: boolean;
  // Runs once per start, after the MCP capability check and before the process is built.
  readonly prepare?: (request: RunnerRequest) => Context | Promise<Context>;
  // Runs exactly once after a successful `prepare`, whatever happens next. Best effort:
  // a failing cleanup never replaces the run's result or the error that stopped it.
  readonly cleanup?: (context: Context) => void | Promise<void>;
  // Fails an exit-zero run the CLI itself shows did not do what Wake required.
  readonly rejectSuccessfulExit?: (
    stdout: string,
    request: RunnerRequest,
    context: Context,
  ) => RunnerFailureDetail | undefined;
  // When set, a successful exit whose parser yields no output fails instead of publishing raw stdout.
  readonly unparsedSuccessFailure?: RunnerFailureDetail;
  readonly parseSuccessfulOutput?: (
    stdout: string,
    request: RunnerRequest,
    context: Context,
  ) => Partial<AgentRunnerResult>;
  readonly classifyFailure?: (input: {
    readonly stdout: string;
    readonly stderr: string;
  }) => RunnerFailureDetail | undefined;
}

export function cliRunner<Context = undefined>(
  name: string,
  command: string,
  args: (request: RunnerRequest, context: Context) => string[],
  options: CliRunnerBehaviour<Context> = {},
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
      const context = (await options.prepare?.(request)) as Context;
      try {
        const process = runProcess(
          command,
          args(request, context),
          request.workspacePath,
          signal,
          processOptions(request, options),
        );
        return {
          identity: {
            kind: ExternalExecutionKind.Process,
            id: process.identity ?? request.runId,
            startedAt: new Date().toISOString(),
          },
          result: process.result
            .then((value) => settle(name, value, request, context, options))
            .finally(() => cleanUp(options, context)),
          cancel: process.cancel,
        };
      } catch (error) {
        await cleanUp(options, context);
        throw error;
      }
    },
  };
}

function processOptions(
  request: RunnerRequest,
  options: Pick<CliRunnerBehaviour, 'runnerTimeouts' | 'createStdoutDecoder'>,
): ProcessExecutionOptions {
  return {
    ...options.runnerTimeouts,
    ...(options.createStdoutDecoder === undefined
      ? {}
      : { stdoutDecoder: options.createStdoutDecoder() }),
    ...(request.onTimeout === undefined ? {} : { onTimeout: request.onTimeout }),
  };
}

async function cleanUp<Context>(
  options: CliRunnerBehaviour<Context>,
  context: Context,
): Promise<void> {
  try {
    await options.cleanup?.(context);
  } catch {
    // A leftover temp file must not discard a finished run's result.
  }
}

function settle<Context>(
  name: string,
  value: ProcessExecutionResult,
  request: RunnerRequest,
  context: Context,
  options: CliRunnerBehaviour<Context>,
): AgentRunnerResult {
  return value.exitCode !== 0 || value.timedOut
    ? {
        transport: RunStatus.Failed,
        output: value.stdout,
        runner: name,
        failure: failureFor(value, options),
      }
    : settleSuccessfulExit(name, value.stdout, request, context, options);
}

function settleSuccessfulExit<Context>(
  name: string,
  stdout: string,
  request: RunnerRequest,
  context: Context,
  options: CliRunnerBehaviour<Context>,
): AgentRunnerResult {
  const rejection = options.rejectSuccessfulExit?.(stdout, request, context);
  if (rejection !== undefined)
    return { transport: RunStatus.Failed, output: stdout, runner: name, failure: rejection };
  const parsed = parseSuccessfulOutput(stdout, request, context, options.parseSuccessfulOutput);
  if (options.unparsedSuccessFailure !== undefined && parsed.output === undefined)
    return {
      transport: RunStatus.Failed,
      output: '',
      runner: name,
      failure: options.unparsedSuccessFailure,
    };
  return {
    transport: RunStatus.Succeeded,
    output: stdout,
    runner: name,
    ...((request.model ?? options.defaultModel) === undefined
      ? {}
      : { model: request.model ?? options.defaultModel }),
    ...parsed,
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

function parseSuccessfulOutput<Context>(
  stdout: string,
  request: RunnerRequest,
  context: Context,
  parser: CliRunnerBehaviour<Context>['parseSuccessfulOutput'],
): Partial<AgentRunnerResult> {
  if (parser === undefined) return {};
  try {
    return parser(stdout, request, context);
  } catch {
    return {};
  }
}
