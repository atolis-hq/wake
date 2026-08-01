import type { Runner } from '../../contracts/runner.js';
import { cliRunner } from './claude.js';

export function createCommandRunner(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Runner {
  return cliRunner('command', command, () => [...args], { timeoutMs });
}
