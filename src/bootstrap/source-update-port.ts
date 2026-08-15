import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourceUpdatePort } from './self-update-application.js';

const execFile = promisify(nodeExecFile);

export interface SourceUpdateProcess {
  execute(command: string, args: readonly string[], cwd: string): Promise<string>;
}

export function createSourceUpdatePort(input: {
  readonly repoRoot: string;
  readonly execute?: SourceUpdateProcess['execute'];
}): SourceUpdatePort {
  const execute = input.execute ?? runProcess;
  return {
    async isClean() {
      return (await execute('git', ['status', '--porcelain'], input.repoRoot)).trim().length === 0;
    },
    async latestTag() {
      const tag = (await candidateTags(execute, input.repoRoot)).at(0);
      if (tag === undefined) throw new Error('No source version tag is available');
      return tag;
    },
    async candidateTags() {
      return candidateTags(execute, input.repoRoot);
    },
    async checkout(tag) {
      await execute('git', ['checkout', tag], input.repoRoot);
    },
    async healthy() {
      try {
        // Verify the checked-out code can be built (TypeScript compiles).
        // This is the minimal meaningful health check: the code must at least compile.
        const buildCommand = 'npm';
        const buildArgs = ['exec', 'tsc', '--'] as const;
        await execute(buildCommand, [...buildArgs], input.repoRoot);
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function candidateTags(
  execute: SourceUpdateProcess['execute'],
  repoRoot: string,
): Promise<readonly string[]> {
  await execute('git', ['fetch', '--tags'], repoRoot);
  const output = await execute('git', ['tag', '--list', 'v*', '--sort=-v:refname'], repoRoot);
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function runProcess(command: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await execFile(command, args, { cwd, encoding: 'utf8' });
  return result.stdout;
}
