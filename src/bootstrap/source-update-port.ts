import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
    async currentTag() {
      try {
        const tag = (
          await execute('git', ['describe', '--tags', '--exact-match'], input.repoRoot)
        ).trim();
        return tag.length === 0 ? null : tag;
      } catch {
        return null;
      }
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
      // Dependencies are part of what a tag means; without refreshing them,
      // node_modules can silently drift from the checked-out
      // package-lock.json and the health check below only ever proves the
      // previously-installed dependencies still compile, not this tag's own.
      await execute('npm', npmInstallArgs(input.repoRoot), input.repoRoot);
    },
    async healthy() {
      try {
        // Verify the checked-out code can be built (TypeScript compiles).
        // This is the minimal meaningful health check: the code must at least compile.
        await execute('npm', ['exec', 'tsc', '--'], input.repoRoot);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function npmInstallArgs(repoRoot: string): readonly string[] {
  return existsSync(join(repoRoot, 'package-lock.json')) ? ['ci', '--include=dev'] : ['install'];
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
  // On Windows, npm resolves to an `npm.cmd` shim: execFile can't spawn it
  // directly (ENOENT, since it isn't a real executable) and refuses to spawn
  // it with a separate argument array either (EINVAL, Node's own hardening
  // after CVE-2024-27980). Routing the whole command through a shell as one
  // string is the platform-sanctioned way to invoke it without the argument
  // array's deprecated, unescaped shell concatenation (DEP0190). Every
  // argument passed to npm here is a fixed literal, never external input, so
  // that lack of escaping is not a code-injection concern. git is a real
  // executable and needs none of this.
  if (process.platform === 'win32' && command === 'npm') {
    const result = await execFile([command, ...args].join(' '), [], {
      cwd,
      encoding: 'utf8',
      shell: true,
    });
    return result.stdout;
  }
  const result = await execFile(command, args, { cwd, encoding: 'utf8' });
  return result.stdout;
}
