import { ExternalExecutionKind } from '../../../activities/index.js';
import { ExecutionCancellationReason, RunStatus } from '../../contracts/vocabulary.js';
import type {
  Runner,
  RunnerExecution,
  RunnerRequest,
  RunnerResult,
} from '../../contracts/runner.js';
import { runProcess } from '../process-execution.js';

export function createClaudeRunner(
  command = 'claude',
  timeoutMs?: number,
  passthroughArgs: readonly string[] = [],
): Runner {
  return cliRunner(
    'claude',
    command,
    (request) => claudeCommandArgs(request, passthroughArgs),
    timeoutMs === undefined ? {} : { timeoutMs },
  );
}

export function claudeCommandArgs(
  request: RunnerRequest,
  passthroughArgs: readonly string[] = [],
): string[] {
  return [
    '-p',
    request.prompt,
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...passthroughArgs,
  ];
}

export function cliRunner(
  name: string,
  command: string,
  args: (request: RunnerRequest) => string[],
  options: { readonly timeoutMs?: number } = {},
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
        result: process.result.then((value): RunnerResult =>
          value.exitCode === 0 && !value.timedOut
            ? {
                transport: RunStatus.Succeeded,
                output: value.stdout,
                runner: name,
                ...(request.model === undefined ? {} : { model: request.model }),
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
