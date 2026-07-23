import { access, chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { createDefaultWakeConfig } from '../config/defaults.js';
import { splitWakeConfig } from '../config/split-config.js';
import { writeYamlFile } from '../lib/yaml-file.js';
import { createWakePaths } from '../lib/paths.js';

async function listPromptFileNames(repoRoot: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, 'prompts'));
  return entries.filter((name) => name.endsWith('.md')).sort();
}

function sanitizeContainerName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return sanitized.length > 0 ? sanitized : 'wake';
}

export async function detectDevMode(repoRoot: string): Promise<'source' | 'packaged'> {
  try {
    await access(join(repoRoot, 'src', 'main.ts'));
    await access(join(repoRoot, 'tsconfig.json'));
    return 'source';
  } catch {
    return 'packaged';
  }
}

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
      if (fileName.endsWith('.sh')) {
        const script = await readFile(sourceFile, 'utf8');
        await writeFile(targetFile, script.replaceAll('\r\n', '\n'), 'utf8');
        await chmod(targetFile, 0o755);
        return;
      }

      await copyFile(sourceFile, targetFile);
    }),
  );
}

export async function scaffoldWakeHome(input: {
  wakeRoot: string;
  repoRoot: string;
  devModeOverride?: 'source' | 'packaged';
}): Promise<void> {
  const wakeRoot = resolve(input.wakeRoot);
  const repoRoot = resolve(input.repoRoot);
  const devMode = input.devModeOverride ?? (await detectDevMode(repoRoot));
  const defaults = createDefaultWakeConfig(wakeRoot);
  const config = {
    ...defaults,
    sandbox: {
      ...defaults.sandbox,
      containerName: `wake-sandbox-${sanitizeContainerName(basename(wakeRoot))}`,
    },
    dev: {
      repoRoot,
      mode: devMode,
    },
  };

  const paths = createWakePaths(wakeRoot);
  const runtimeDirectories = [
    paths.dataRoot,
    join(paths.dataRoot, 'events'),
    join(paths.dataRoot, 'state'),
    join(paths.dataRoot, 'runs'),
    join(paths.dataRoot, 'sources'),
    join(paths.dataRoot, 'repos'),
    join(paths.dataRoot, 'locks'),
    join(paths.dataRoot, 'logs'),
    join(paths.dataRoot, 'control'),
    join(paths.dataRoot, 'container-home'),
    join(paths.dataRoot, 'transcripts'),
    paths.workspaceRoot,
  ];

  await Promise.all(
    runtimeDirectories.map((directoryPath) => mkdir(directoryPath, { recursive: true })),
  );

  const { infra, workflow } = splitWakeConfig(config);
  const promptFileNames = await listPromptFileNames(repoRoot);

  await Promise.all([
    copyAssets(repoRoot, 'prompts', join(wakeRoot, 'prompts'), promptFileNames),
    copyFile(join(repoRoot, 'templates', 'SETUP.md'), join(wakeRoot, 'SETUP.md')),
    writeYamlFile(join(wakeRoot, 'config.yaml'), infra),
    writeYamlFile(join(wakeRoot, 'config.workflows.yaml'), workflow),
  ]);
}
