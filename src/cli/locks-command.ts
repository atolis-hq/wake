import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function runLocksCommand(input: {
  args: string[];
  locksDir: string;
}): Promise<{ status: 'cleared' | 'not-locked' }> {
  const subcommand = input.args[0];
  if (subcommand !== 'clear') {
    throw new Error(
      `Unknown locks subcommand: ${subcommand ?? '(none)'}. Try "wake locks clear".`,
    );
  }

  let lockFiles: string[];
  try {
    lockFiles = (await readdir(input.locksDir)).filter((f) => f.endsWith('.lock'));
  } catch {
    return { status: 'not-locked' };
  }

  if (lockFiles.length === 0) {
    return { status: 'not-locked' };
  }

  await Promise.all(lockFiles.map((f) => rm(join(input.locksDir, f), { force: true })));
  return { status: 'cleared' };
}
