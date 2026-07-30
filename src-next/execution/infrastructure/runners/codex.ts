import type { Runner, RunnerRequest } from '../../contracts/runner.js';
import { cliRunner } from './claude.js';

export function createCodexRunner(command = 'codex'): Runner {
  return cliRunner('codex', command, (request: RunnerRequest) => [
    'exec',
    request.prompt,
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...(request.resumeSessionId === undefined ? [] : ['resume', request.resumeSessionId]),
  ]);
}
