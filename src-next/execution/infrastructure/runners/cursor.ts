import type { Runner, RunnerRequest } from '../../contracts/runner.js';
import { cliRunner } from './claude.js';

export function createCursorRunner(
  command = 'cursor',
  timeoutMs?: number,
  passthroughArgs: readonly string[] = [],
): Runner {
  return cliRunner(
    'cursor',
    command,
    (request: RunnerRequest) => cursorCommandArgs(request, passthroughArgs),
    timeoutMs === undefined ? {} : { timeoutMs },
  );
}

export function cursorCommandArgs(
  request: RunnerRequest,
  passthroughArgs: readonly string[] = [],
): string[] {
  return [
    '--print',
    request.prompt,
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...passthroughArgs,
  ];
}
