#!/usr/bin/env node
// Dev-mode entry point: runs src-next/main.ts live via this checkout's own tsx,
// so `npm link` gives you a short `wake-dev <command>` instead of typing
// `npx tsx src-next/main.ts <command>` every time. Resolves tsx from this repo's
// own node_modules rather than the caller's cwd, so it works regardless of
// which directory (e.g. a wake-home) you run it from.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainTs = resolve(repoRoot, 'src-next', 'main.ts');

if (!existsSync(mainTs)) {
  console.error(
    'wake-dev only works from a source checkout (no src-next/main.ts found next to this install).\n' +
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
