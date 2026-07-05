import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { createDefaultWakeConfig } from '../config/defaults.js';
import { writeJsonFile } from '../lib/json-file.js';

const runtimeDirectoryNames = [
  'events',
  'state',
  'runs',
  'workspaces',
  'repos',
  'sources',
  'locks',
] as const;

const promptFileNames = [
  'refine.start.md',
  'refine.resume.md',
  'implement.start.md',
  'implement.resume.md',
] as const;

const dockerAssetNames = ['Dockerfile', 'setup.sh'] as const;

export async function assertEmptyDirectory(targetDir: string): Promise<void> {
  try {
    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      throw new Error(`wake init requires an empty directory: ${targetDir}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      await mkdir(targetDir, { recursive: true });
      return;
    }

    throw error;
  }
}

async function copyAssets(
  repoRoot: string,
  sourceDir: string,
  targetDir: string,
  fileNames: readonly string[],
): Promise<void> {
  await mkdir(targetDir, { recursive: true });

  await Promise.all(
    fileNames.map(async (fileName) => {
      const sourceFile = join(repoRoot, sourceDir, fileName);
      const targetFile = join(targetDir, fileName);
      await mkdir(dirname(targetFile), { recursive: true });
      await copyFile(sourceFile, targetFile);
    }),
  );
}

export async function scaffoldWakeHome(input: {
  wakeRoot: string;
  repoRoot: string;
}): Promise<void> {
  const wakeRoot = resolve(input.wakeRoot);
  const repoRoot = resolve(input.repoRoot);

  await Promise.all(
    runtimeDirectoryNames.map((directoryName) =>
      mkdir(join(wakeRoot, directoryName), { recursive: true }),
    ),
  );

  await Promise.all([
    copyAssets(repoRoot, 'prompts', join(wakeRoot, 'prompts'), promptFileNames),
    copyAssets(repoRoot, 'docker', join(wakeRoot, 'docker'), dockerAssetNames),
    writeJsonFile(join(wakeRoot, 'config.json'), createDefaultWakeConfig(wakeRoot)),
  ]);
}
