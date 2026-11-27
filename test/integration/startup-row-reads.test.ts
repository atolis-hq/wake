import { createEventData, registerViewSnapshotStore } from '@atolis-hq/eventing';
import { FileEventJournal, FileViewSnapshotStore } from '@atolis-hq/eventing-filesystem';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TriggerStateReader } from '../../src/control-plane/application/trigger-state-reader.js';
import { RunRepository } from '../../src/execution/application/run-repository.js';
import { ResourceRepository } from '../../src/resources/application/resource-repository.js';
import { WorkIndex } from '../../src/work/application/work-index.js';
import { FakeClock } from '../e2e/support/world.js';

const TOTAL = 20_000;
const BATCH = 1_000;

function draft(index: number) {
  return createEventData({
    eventId: `bench-${index}`,
    eventType: 'bench.noise',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: `bench-${index}`,
    actor: { kind: 'system', id: 'bench' },
    source: { kind: 'internal', id: 'bench' },
    payload: {},
  });
}

async function seededJournal(root: string): Promise<FileEventJournal> {
  const journal = new FileEventJournal(root, new FakeClock());
  for (let start = 0; start < TOTAL; start += BATCH)
    await journal.appendToStream(
      { kind: 'bench', id: `stream-${start}` },
      0,
      Array.from({ length: BATCH }, (_, offset) => draft(start + offset)),
    );
  return journal;
}

/** The five resident consumers that each used to replay the whole journal at startup. */
async function startConsumers(journal: FileEventJournal, triggers = true): Promise<void> {
  const resources = new ResourceRepository(journal);
  await Promise.all([
    new WorkIndex(journal, { minEvents: 1, minIntervalMs: 0 }).snapshot(),
    new RunRepository(journal).list(),
    triggers ? new TriggerStateReader(journal).get() : Promise.resolve(),
    resources.listResourceIds(),
    resources.listRetryCandidateIds(),
  ]);
}

async function rowsRead(journal: FileEventJournal, run: () => Promise<void>): Promise<number> {
  const readAll = vi.spyOn(journal, 'readAll');
  await run();
  const rows = (await Promise.all(readAll.mock.results.map((r) => r.value))).flat().length;
  readAll.mockRestore();
  return rows;
}

it(
  'reads the journal about once across every startup consumer, and almost nothing after a restart',
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-startup-rows-'));
    const store = new FileViewSnapshotStore(join(root, 'view-snapshots'));
    const writer = await seededJournal(root);
    registerViewSnapshotStore(writer, store);

    const cold = await rowsRead(writer, () => startConsumers(writer));
    await new Promise((resolve) => setTimeout(resolve, 200));
    // A fresh process: new journal object, same files and snapshots.
    const restarted = new FileEventJournal(root, new FakeClock());
    registerViewSnapshotStore(restarted, store);
    const warm = await rowsRead(restarted, () => startConsumers(restarted, false));

    console.log(`startup rows read: cold=${cold} warm=${warm} journal=${TOTAL}`);
    expect(cold).toBeLessThanOrEqual(TOTAL * 1.2);
    // Persisted views read ~0 rows on restart (the trigger reader has no snapshot, so it is excluded).
    expect(warm).toBeLessThanOrEqual(10);
  },
);
