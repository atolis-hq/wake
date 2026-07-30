import type { Runner, RunnerRequest } from '../../contracts/runner.js';
import { cliRunner } from './claude.js';

export function createCursorRunner(command = 'cursor'): Runner {
  return cliRunner('cursor', command, (request: RunnerRequest) => [
    '--print',
    request.prompt,
    ...(request.model === undefined ? [] : ['--model', request.model]),
  ]);
}
