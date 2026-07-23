#!/usr/bin/env node
// Dev-mode entry point: runs src/main.ts live via this checkout's own tsx,
// so `npm link` gives you a short `wake-dev <command>` instead of typing
// `npx tsx src/main.ts <command>` every time. Resolves tsx from this repo's
// own node_modules rather than the caller's cwd, so it works regardless of
// which directory (e.g. a wake-home) you run it from.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainTs = resolve(repoRoot, 'src', 'main.ts');

if (!existsSync(mainTs)) {
  console.error(
    'wake-dev only works from a source checkout (no src/main.ts found next to this install).\n' +
      'This is a packaged install — use `wake` instead.',
  );
  process.exit(1);
}

const tsxBin = resolve(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);

const result = spawnSync(tsxBin, [mainTs, ...process.argv.slice(2)], {
  stdio: 'inherit',
  // Windows npm bin shims (tsx.cmd) are batch files — CreateProcess can't
  // exec them directly, they need the shell to interpret them.
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
