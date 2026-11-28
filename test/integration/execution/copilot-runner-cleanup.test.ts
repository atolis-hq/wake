import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCopilotRunner } from '../../../src/execution/index.js';

const request = { runId: 'run-1', prompt: 'ship', allowedTools: [] };

// A fake Copilot that always creates its usage file, then behaves as asked.
const fakeCopilot = (behaviour: string) =>
  [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const file = process.argv[process.argv.indexOf('--usage-output-file') + 1];",
    "fs.writeFileSync(file, '{}');",
    behaviour,
  ].join('\n');

describe('Copilot runner usage-file cleanup', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  async function install(behaviour: string): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), 'wake-copilot-test-'));
    const command = join(directory, 'copilot');
    await writeFile(command, fakeCopilot(behaviour));
    await chmod(command, 0o755);
    return command;
  }

  it.each([
    { name: 'a non-zero exit', behaviour: 'process.exit(4);', expected: 'failed' },
    { name: 'a clean exit with no result', behaviour: 'process.exit(0);', expected: 'failed' },
  ])('removes the usage file after $name', async ({ behaviour, expected }) => {
    const command = await install(behaviour);
    const before = await usageFiles();

    const execution = await createCopilotRunner({ command }).start(
      request,
      new AbortController().signal,
    );

    await expect(execution.result).resolves.toMatchObject({ transport: expected });
    expect(await usageFiles()).toEqual(before);
  });

  it('removes the usage file after a timeout', async () => {
    const command = await install('setTimeout(() => {}, 5_000);');
    const before = await usageFiles();

    const execution = await createCopilotRunner({
      command,
      runnerTimeouts: { hardMs: 500, cancellationGraceMs: 5 },
    }).start(request, new AbortController().signal);

    await expect(execution.result).resolves.toMatchObject({ transport: 'failed' });
    expect(await usageFiles()).toEqual(before);
  });

  it('removes the usage file after the run is aborted', async () => {
    const command = await install("process.stdout.write('started'); setTimeout(() => {}, 5_000);");
    const before = await usageFiles();
    const controller = new AbortController();

    const execution = await createCopilotRunner({
      command,
      runnerTimeouts: { cancellationGraceMs: 5 },
    }).start(request, controller.signal);
    await waitForUsageFiles(before.length + 1);
    controller.abort();

    await expect(execution.result).resolves.toMatchObject({ transport: 'failed' });
    expect(await usageFiles()).toEqual(before);
  });

  it('gives every invocation its own usage file', async () => {
    const command = await install('setTimeout(() => process.exit(0), 5_000);');
    const before = await usageFiles();
    const first = new AbortController();
    const second = new AbortController();
    const runner = createCopilotRunner({
      command,
      runnerTimeouts: { cancellationGraceMs: 5 },
    });

    const executions = [
      await runner.start(request, first.signal),
      await runner.start(request, second.signal),
    ];
    await waitForUsageFiles(before.length + 2);
    first.abort();
    second.abort();
    await Promise.all(executions.map((execution) => execution.result));

    expect(await usageFiles()).toEqual(before);
  });
});

async function usageFiles(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('wake-copilot-usage-')).sort();
}

// The fake creates its usage file once its node process is up.
async function waitForUsageFiles(count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await usageFiles()).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`usage files never reached ${count}`);
}
