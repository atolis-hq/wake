import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { correlationId } from '../../../src-next/kernel/index.js';
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProjectionStore,
  ProjectionRunner,
} from '../../../src-next/persistence/index.js';
import { createWorkService, workProjection } from '../../../src-next/work/index.js';
import { workId } from '../../support/identities.js';
import { FakeClock } from '../support/world.js';

it('E2E-PROJECTION-001 rebuilds projections without changing journal bytes', async () => {
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
  const runner = new ProjectionRunner(journal, projections, checkpoints);
  await runner.runOnce(workProjection);
  const eventPath = join(root, 'events', '2026-07-30.jsonl');
  const before = await readFile(eventPath, 'utf8');
  await rm(join(root, 'projections'), { recursive: true });
  await runner.rebuild(workProjection);
  expect((await projections.read('work', workId('1')))?.value).toMatchObject({ objective: 'ship' });
  expect(await readFile(eventPath, 'utf8')).toBe(before);
  expect(await checkpoints.load('projection:work')).toBe(1);
});
