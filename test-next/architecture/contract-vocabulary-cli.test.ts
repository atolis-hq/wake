import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cliPath = resolve('scripts/check-contract-vocabulary.mjs');
const fixtureRoots: string[] = [];
const usage = 'Usage: node scripts/check-contract-vocabulary.mjs [--rules rule,rule]\n';

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function cliFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-contract-vocabulary-cli-'));
  fixtureRoots.push(root);
  await mkdir(join(root, 'src-next'));
  return root;
}

function runCli(root: string, arguments_: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('contract vocabulary CLI', () => {
  it('accepts a valid non-empty rule selection', async () => {
    const root = await cliFixture();

    const result = runCli(root, ['--rules', 'event-literals,stream-literals']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Contract vocabulary valid\n');
    expect(result.stderr).toBe('');
  });

  it('rejects an empty rule selection concisely', async () => {
    const root = await cliFixture();

    const result = runCli(root, ['--rules=']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`Contract vocabulary rules must not be empty\n${usage}`);
  });

  it('rejects unknown rules concisely', async () => {
    const root = await cliFixture();

    const result = runCli(root, ['--rules', 'event-literals,nope']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`Unknown contract-vocabulary rule: nope\n${usage}`);
  });
});
