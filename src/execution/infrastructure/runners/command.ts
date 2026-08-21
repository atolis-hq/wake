import type { Runner } from '../../contracts/runner.js';
import type { ProcessTimeouts } from '../process-execution.js';
import { cliRunner } from './claude.js';

export function createCommandRunner(
  command: string,
  args: readonly string[],
  runnerTimeouts: ProcessTimeouts,
): Runner {
  return cliRunner('command', command, () => [...args], { runnerTimeouts });
}
