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
      const tag = (await execute('git', ['tag', '--sort=-v:refname'], input.repoRoot))
        .split(/\r?\n/u)
        .find((value) => value.trim().length > 0)
        ?.trim();
      if (tag === undefined) throw new Error('No source version tag is available');
      return tag;
    },
    async checkout(tag) {
      await execute('git', ['checkout', tag], input.repoRoot);
    },
    async healthy() {
      try {
        await execute('git', ['rev-parse', '--verify', 'HEAD'], input.repoRoot);
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function runProcess(command: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await execFile(command, args, { cwd, encoding: 'utf8' });
  return result.stdout;
}
