import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const runtimeDirectories = [
  'events',
  'projections',
  'checkpoints',
  'locks',
  'transcripts',
  'logs',
  'container-home',
] as const;

/** Creates a new Wake home; runtime state always stays under its hidden .wake directory. */
export async function initialiseWakeHome(
  wakeRoot: string,
  assets: Readonly<Record<string, string>>,
): Promise<void> {
  await assertEmptyDirectory(wakeRoot);
  const dataRoot = join(wakeRoot, '.wake');
  await Promise.all([
    ...runtimeDirectories.map((directory) => mkdir(join(dataRoot, directory), { recursive: true })),
    mkdir(join(wakeRoot, 'workspaces'), { recursive: true }),
  ]);
  await Promise.all(
    Object.entries(assets).map(async ([path, content]) => {
      const target = join(wakeRoot, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }),
  );
}

async function assertEmptyDirectory(path: string): Promise<void> {
  try {
    if ((await readdir(path)).length > 0) throw new Error(`Wake root is not empty: ${path}`);
  } catch (error) {
    if (isMissingDirectory(error)) return;
    throw error;
  }
}

function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
