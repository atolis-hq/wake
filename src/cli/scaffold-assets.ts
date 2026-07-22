import { access, chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { createDefaultWakeConfig } from '../config/defaults.js';
import { writeJsonFile } from '../lib/json-file.js';
import { createWakePaths } from '../lib/paths.js';

const promptFileNames = ['refine.md', 'implement.md'] as const;

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

async function writeLaunchers(wakeRoot: string, repoRoot: string): Promise<void> {
  const posixRepoRoot = repoRoot.replaceAll('\\', '/');
  const shellLauncher = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `WAKE_REPO="${posixRepoRoot}"`,
    'DIST_MAIN="$WAKE_REPO/dist/src/main.js"',
    'SOURCE_MAIN="$WAKE_REPO/src/main.ts"',
    'CONTAINER_MAIN="/app/dist/src/main.js"',
    '',
    'run_local_wake() {',
    '  if [[ -f "$DIST_MAIN" ]]; then',
    '    exec env MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL=\'*\' node "$DIST_MAIN" "$@"',
    '  fi',
    '  exec env MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL=\'*\' npx tsx "$SOURCE_MAIN" "$@"',
    '}',
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
    '    run_local_wake "$@"',
    '    ;;',
    '  *)',
    '    mapfile -d \'\' -t rewritten_args < <(rewrite_runtime_args "$@")',
    '    run_local_wake sandbox exec -- node "$CONTAINER_MAIN" "${rewritten_args[@]}"',
    '    ;;',
    'esac',
    '',
  ].join('\n');
  const powerShellLauncher = [
    '$ErrorActionPreference = "Stop"',
    '',
    `$wakeRepo = "${repoRoot.replaceAll('"', '""')}"`,
    '$distMain = Join-Path $wakeRepo "dist/src/main.js"',
    '$sourceMain = Join-Path $wakeRepo "src/main.ts"',
    '$containerMain = "/app/dist/src/main.js"',
    '$command = if ($Args.Count -gt 0) { [string] $Args[0] } else { "" }',
    '',
    'function Invoke-WakeLocal {',
    '  param([string[]] $WakeArgs)',
    '  if (Test-Path $distMain) {',
    '    & node $distMain @WakeArgs',
    '    exit $LASTEXITCODE',
    '  }',
    '  & npx tsx $sourceMain @WakeArgs',
    '  exit $LASTEXITCODE',
    '}',
    '',
    'switch ($command) {',
    '  "init" {',
    '    Invoke-WakeLocal -WakeArgs $Args',
    '  }',
    '  "sandbox" {',
    '    Invoke-WakeLocal -WakeArgs $Args',
    '  }',
    '  "stop" {',
    '    Invoke-WakeLocal -WakeArgs $Args',
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
    "    Invoke-WakeLocal -WakeArgs (@('sandbox', 'exec', '--', 'node', $containerMain) + $rewrittenArgs.ToArray())",
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

  await Promise.all([
    copyAssets(repoRoot, 'prompts', join(wakeRoot, 'prompts'), promptFileNames),
    writeJsonFile(join(wakeRoot, 'config.json'), config),
    writeLaunchers(wakeRoot, repoRoot),
  ]);
}
