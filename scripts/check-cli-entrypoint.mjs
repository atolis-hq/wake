import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entrypoint = await readFile('dist/src/main.js', 'utf8');

if (!entrypoint.startsWith('#!/usr/bin/env node\n')) {
  throw new Error('The compiled Wake CLI entrypoint must declare Node as its interpreter.');
}

const compiledEntrypoint = resolve('dist/src/main.js');
const symlinkDirectory = await mkdtemp(join(tmpdir(), 'wake-cli-entrypoint-'));
const symlinkEntrypoint = join(symlinkDirectory, 'wake');

try {
  await symlink(compiledEntrypoint, symlinkEntrypoint);
  assertVersionOutput(compiledEntrypoint, 'direct compiled invocation');
  assertVersionOutput(symlinkEntrypoint, 'symlinked compiled invocation');
} finally {
  await rm(symlinkDirectory, { recursive: true, force: true });
}

function assertVersionOutput(invocation, description) {
  const result = spawnSync(process.execPath, [invocation, '--version'], { encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 || result.stdout.trim() === '') {
    throw new Error(
      `${description} must print a version and exit successfully: ${result.stderr || result.stdout}`,
    );
  }
}
