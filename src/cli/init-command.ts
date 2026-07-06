import { resolve } from 'node:path';

import { assertEmptyDirectory, scaffoldWakeHome } from './scaffold-assets.js';

export async function runInitCommand(input: {
  cwd: string;
  args: string[];
  repoRoot: string;
}): Promise<{ wakeRoot: string }> {
  const wakeRoot = resolve(input.cwd, input.args[0] ?? '.');

  await assertEmptyDirectory(wakeRoot);
  await scaffoldWakeHome({
    wakeRoot,
    repoRoot: input.repoRoot,
  });

  return { wakeRoot };
}
