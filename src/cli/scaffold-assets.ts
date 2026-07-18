import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
  'logs',
] as const;

const promptFileNames = ['refine.md', 'implement.md'] as const;

const dockerAssetNames = ['Dockerfile', 'setup.sh', 'log-command.sh'] as const;

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

async function writeLaunchers(wakeRoot: string, repoRoot: string): Promise<void> {
  const posixRepoRoot = repoRoot.replaceAll('\\', '/');
  const shellLauncher = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `WAKE_REPO="${posixRepoRoot}"`,
    'LOCAL_MAIN="$WAKE_REPO/src/main.ts"',
    'CONTAINER_MAIN="/app/dist/src/main.js"',
    '',
    'rewrite_runtime_args() {',
    '  local rewritten_args=()',
    '  local saw_wake_root=0',
    '  while (($# > 0)); do',
    '    if [[ "$1" == "--wake-root" ]]; then',
    '      saw_wake_root=1',
    '      shift',
    '      if (($# > 0)); then',
    '        shift',
    '      fi',
    '      rewritten_args+=("--wake-root" "/wake")',
    '      continue',
    '    fi',
    '    rewritten_args+=("$1")',
    '    shift',
    '  done',
    '  if [[ $saw_wake_root -eq 0 ]]; then',
    '    rewritten_args+=("--wake-root" "/wake")',
    '  fi',
    '  printf \'%s\\0\' "${rewritten_args[@]}"',
    '}',
    '',
    'case "${1:-}" in',
    '  init|sandbox|stop)',
    '    exec npx tsx "$LOCAL_MAIN" "$@"',
    '    ;;',
    '  *)',
    '    mapfile -d \'\' -t rewritten_args < <(rewrite_runtime_args "$@")',
    '    exec env MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL=\'*\' npx tsx "$LOCAL_MAIN" sandbox exec -- node "$CONTAINER_MAIN" "${rewritten_args[@]}"',
    '    ;;',
    'esac',
    '',
  ].join('\n');
  const powerShellLauncher = [
    '$ErrorActionPreference = "Stop"',
    '',
    `$wakeRepo = "${repoRoot.replaceAll('"', '""')}"`,
    '$localMain = Join-Path $wakeRepo "src/main.ts"',
    '$containerMain = "/app/dist/src/main.js"',
    '$command = if ($Args.Count -gt 0) { [string] $Args[0] } else { "" }',
    '',
    'switch ($command) {',
    '  "init" {',
    '    & npx tsx $localMain @Args',
    '    exit $LASTEXITCODE',
    '  }',
    '  "sandbox" {',
    '    & npx tsx $localMain @Args',
    '    exit $LASTEXITCODE',
    '  }',
    '  "stop" {',
    '    & npx tsx $localMain @Args',
    '    exit $LASTEXITCODE',
    '  }',
    '  default {',
    '    $rewrittenArgs = New-Object System.Collections.Generic.List[string]',
    '    $sawWakeRoot = $false',
    '    for ($index = 0; $index -lt $Args.Count; $index++) {',
    '      $arg = [string] $Args[$index]',
    '      if ($arg -eq "--wake-root") {',
    '        $sawWakeRoot = $true',
    '        if ($index + 1 -lt $Args.Count) {',
    '          $index++',
    '        }',
    "        $rewrittenArgs.Add('--wake-root')",
    "        $rewrittenArgs.Add('/wake')",
    '        continue',
    '      }',
    '      $rewrittenArgs.Add($arg)',
    '    }',
    '    if (-not $sawWakeRoot) {',
    "      $rewrittenArgs.Add('--wake-root')",
    "      $rewrittenArgs.Add('/wake')",
    '    }',
    '    & npx tsx $localMain sandbox exec -- node $containerMain @($rewrittenArgs.ToArray())',
    '    exit $LASTEXITCODE',
    '  }',
    '}',
    '',
  ].join('\n');

  await writeFile(join(wakeRoot, 'wake.sh'), shellLauncher, 'utf8');
  await writeFile(join(wakeRoot, 'wake.ps1'), powerShellLauncher, 'utf8');
  await chmod(join(wakeRoot, 'wake.sh'), 0o755);
}

export async function scaffoldWakeHome(input: {
  wakeRoot: string;
  repoRoot: string;
}): Promise<void> {
  const wakeRoot = resolve(input.wakeRoot);
  const repoRoot = resolve(input.repoRoot);
  const config = {
    ...createDefaultWakeConfig(wakeRoot),
    dev: {
      repoRoot,
    },
  };

  await Promise.all(
    runtimeDirectoryNames.map((directoryName) =>
      mkdir(join(wakeRoot, directoryName), { recursive: true }),
    ),
  );

  await Promise.all([
    copyAssets(repoRoot, 'prompts', join(wakeRoot, 'prompts'), promptFileNames),
    copyAssets(repoRoot, 'docker', join(wakeRoot, 'docker'), dockerAssetNames),
    writeJsonFile(join(wakeRoot, 'config.json'), config),
    writeLaunchers(wakeRoot, repoRoot),
  ]);
}
