import { access, rm } from 'node:fs/promises';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runLocksCommand(input: {
  args: string[];
  tickLockFile: string;
}): Promise<{ status: 'cleared' | 'not-locked' }> {
  const subcommand = input.args[0];
  if (subcommand !== 'clear') {
    throw new Error(
      `Unknown locks subcommand: ${subcommand ?? '(none)'}. Try "wake locks clear".`,
    );
  }

  const existed = await fileExists(input.tickLockFile);
  await rm(input.tickLockFile, { force: true });

  return { status: existed ? 'cleared' : 'not-locked' };
}
