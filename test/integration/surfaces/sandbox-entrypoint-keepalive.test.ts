import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tsxCli = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const fixture = resolve(repoRoot, 'test/integration/surfaces/fixtures/wait-forever-fixture.ts');

describe('sandbox entrypoint waitForever', () => {
  it('keeps a real process alive with nothing else pending, matching the unref-detached supervised container', async () => {
    const child = spawn(process.execPath, [tsxCli, fixture], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });

    await new Promise<void>((resolveReady, reject) => {
      let buffered = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        if (buffered.includes('ready')) resolveReady();
      });
      child.once('error', reject);
    });

    // Nothing besides waitForever() is pending in the fixture, mirroring
    // production where the supervised child is unref'd. If waitForever()
    // doesn't itself register a real event-loop handle, the process exits
    // almost immediately despite never resolving the awaited promise.
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));

    expect(exited).toBe(false);
    child.kill('SIGTERM');
  }, 15_000);
});
