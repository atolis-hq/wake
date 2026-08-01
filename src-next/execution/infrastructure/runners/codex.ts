import type { Runner, RunnerRequest } from '../../contracts/runner.js';
import { cliRunner } from './claude.js';

export function createCodexRunner(
  command = 'codex',
  timeoutMs?: number,
  passthroughArgs: readonly string[] = [],
): Runner {
  return cliRunner(
    'codex',
    command,
    (request: RunnerRequest) => codexCommandArgs(request, passthroughArgs),
    timeoutMs === undefined ? {} : { timeoutMs },
  );
}

export function codexCommandArgs(
  request: RunnerRequest,
  passthroughArgs: readonly string[] = [],
): string[] {
  return [
    'exec',
    request.prompt,
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...(request.resumeSessionId === undefined ? [] : ['resume', request.resumeSessionId]),
    ...passthroughArgs,
  ];
}
