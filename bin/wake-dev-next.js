#!/usr/bin/env node
// Target dev-mode entry point.  It deliberately stays separate from wake-dev
// until the target CLI replaces the legacy package entrypoint at cutover.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainTs = resolve(repoRoot, 'src-next', 'main.ts');

if (!existsSync(mainTs)) {
  console.error(
    'wake-dev-next only works from a source checkout (no src-next/main.ts found next to this install).\n' +
      'This is a packaged install — use wake instead.',
  );
  process.exit(1);
}

const tsxCli = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const result = spawnSync(process.execPath, [tsxCli, mainTs, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
