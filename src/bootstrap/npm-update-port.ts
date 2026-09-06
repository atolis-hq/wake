import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourceUpdatePort } from './self-update-application.js';

const execFile = promisify(nodeExecFile);

export interface NpmUpdateProcess {
  execute(command: string, args: readonly string[]): Promise<string>;
}

/** Resolves immutable published package versions. Installation is performed by the rollout. */
export function createNpmUpdatePort(input: {
  readonly packageName: string;
  readonly distTag?: string;
  readonly registry?: string;
  readonly execute?: NpmUpdateProcess['execute'];
}): SourceUpdatePort {
  const execute = input.execute ?? runProcess;
  const distTag = input.distTag ?? 'latest';
  const registry = input.registry === undefined ? [] : [`--registry=${input.registry}`];
  return {
    isClean: async () => true,
    async latestTag() {
      const resolved = await resolveVersion();
      if (resolved === undefined)
        throw new Error(`No npm version is available for ${input.packageName}`);
      return resolved;
    },
    async candidateTags() {
      const resolved = await resolveVersion();
      return resolved === undefined ? [] : [resolved];
    },
    // The Docker rollout installs this exact version. Keeping this side-effect-free means
    // the updater never overwrites the CLI process which is coordinating the update.
    checkout: async () => {},
    healthy: async () => true,
  };

  async function resolveVersion(): Promise<string | undefined> {
    const output = await execute('npm', [
      'view',
      `${input.packageName}@${distTag}`,
      'version',
      '--json',
      ...registry,
    ]);
    const parsed: unknown = JSON.parse(output);
    const value = Array.isArray(parsed) ? parsed.at(0) : parsed;
    if (
      typeof value !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
    )
      throw new Error(`npm returned an invalid version for ${input.packageName}@${distTag}`);
    return value;
  }
}

async function runProcess(command: string, args: readonly string[]): Promise<string> {
  const result = await execFile(command, args, { encoding: 'utf8' });
  return result.stdout;
}
