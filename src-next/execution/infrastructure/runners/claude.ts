import { ExternalExecutionKind } from '../../../activities/index.js';
import { RunStatus } from '../../contracts/vocabulary.js';
import type {
  Runner,
  RunnerExecution,
  RunnerRequest,
  RunnerResult,
} from '../../contracts/runner.js';
import { runProcess } from '../process-execution.js';

export function createClaudeRunner(command = 'claude'): Runner {
  return cliRunner('claude', command, (request) => [
    '-p',
    request.prompt,
    ...(request.model === undefined ? [] : ['--model', request.model]),
  ]);
}

export function cliRunner(
  name: string,
  command: string,
  args: (request: RunnerRequest) => string[],
): Runner {
  return {
    async start(request, signal): Promise<RunnerExecution> {
      const process = runProcess(command, args(request), request.workspacePath, signal);
      return {
        identity: {
          kind: ExternalExecutionKind.Process,
          id: request.runId,
          startedAt: new Date().toISOString(),
        },
        result: process.result.then((value): RunnerResult =>
          value.exitCode === 0
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
                  kind: 'process-exit',
                  message: value.stderr || `exit ${value.exitCode}`,
                },
              },
        ),
        cancel: process.cancel,
      };
    },
  };
}
