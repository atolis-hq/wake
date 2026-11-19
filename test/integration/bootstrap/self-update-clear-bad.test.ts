import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createCompositionRoot,
  createSurfaceApplications,
  createUpdateLedger,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import { parseWakeCommand, runWakeCommand } from '../../../src/surfaces/index.js';

it('routes clear-bad through the composed CLI without starting an update', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-clear-bad-'));
  try {
    const root = await createCompositionRoot(home, {
      config: parseRootConfig({
        execution: {
          agentRunners: { fake: { kind: 'fake' } },
          runnerPools: { standard: ['fake'] },
          defaultRunnerPool: 'standard',
        },
      }),
      journal: new InMemoryEventJournal({ now: () => new Date('2026-11-19T00:00:00Z') }),
      checkpoints: new InMemoryCheckpointStore(),
      projections: new InMemoryProjectionStore(),
    });
    const ledger = createUpdateLedger(home);
    await ledger.recordBad('0.4.125');
    const { cli } = await createSurfaceApplications(root);
    const output: string[] = [];
    await runWakeCommand(
      parseWakeCommand(['self-update', 'clear-bad', '0.4.125', '--wake-root', home]),
      cli,
      { write: (value) => output.push(value) },
      new AbortController().signal,
    );
    expect(output).toEqual(['{"tag":"0.4.125","cleared":true}\n']);
    expect(await ledger.isBad('0.4.125')).toBe(false);
    await expect(cli.operational!.selfUpdate(['clear-bad'])).rejects.toThrow('Usage:');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
