import {
  correlationId,
  createProjectionProcessor,
  EventProcessorHost,
  ProjectionRebuilder,
} from '@atolis-hq/eventing';
import {
  createFileProcessorRunSerialiser,
  FileCheckpointStore,
  FileEventJournal,
  FileProjectionStore,
} from '@atolis-hq/eventing-filesystem';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createWorkService, workProjection } from '../../../src/work/index.js';
import { workId } from '../../support/identities.js';
import { FakeClock } from '../support/world.js';

const scenario = { id: 'E2E-PROJECTION-001' } as const;

it(`${scenario.id} rebuilds projections without changing journal bytes`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-projection-recovery-'));
  const clock = new FakeClock();
  const journal = new FileEventJournal(root, clock);
  await createWorkService(journal).create(
    { workItemId: workId('1'), objective: 'ship' },
    {
      commandId: 'create',
      correlationId: correlationId('corr'),
      occurredAt: clock.now().toISOString(),
      actor: { kind: 'operator', id: 'test' },
    },
  );
  const projections = new FileProjectionStore(root);
  const checkpoints = new FileCheckpointStore(root);
  const serialiseRun = createFileProcessorRunSerialiser(root);
  const subscription = createProjectionProcessor(workProjection, projections);
  const host = new EventProcessorHost(journal, checkpoints, serialiseRun, new FakeClock());
  await host.runOnce(subscription);
  const eventPath = join(root, 'events', '2026-07-30.jsonl');
  const before = await readFile(eventPath, 'utf8');
  await rm(join(root, 'projections'), { recursive: true });
  await new ProjectionRebuilder(journal, projections, checkpoints, serialiseRun).rebuild(
    workProjection,
  );
  expect((await projections.read('work', workId('1')))?.value).toMatchObject({ objective: 'ship' });
  expect(await readFile(eventPath, 'utf8')).toBe(before);
  expect(await checkpoints.load('projection:work')).toBe(1);
});
