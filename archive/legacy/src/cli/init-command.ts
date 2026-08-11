import { resolve } from 'node:path';

import { assertEmptyDirectory, scaffoldWakeHome } from './scaffold-assets.js';

export async function runInitCommand(input: {
  cwd: string;
  args: string[];
  repoRoot: string;
}): Promise<{ wakeRoot: string }> {
  const positionalArgs = input.args.filter((arg) => arg !== '--dev' && arg !== '--packaged');
  const wakeRoot = resolve(input.cwd, positionalArgs[0] ?? '.');
  const devModeOverride = input.args.includes('--dev')
    ? 'source'
    : input.args.includes('--packaged')
      ? 'packaged'
      : undefined;

  await assertEmptyDirectory(wakeRoot);
  await scaffoldWakeHome({
    wakeRoot,
    repoRoot: input.repoRoot,
    ...(devModeOverride === undefined ? {} : { devModeOverride }),
  });

  return { wakeRoot };
}
