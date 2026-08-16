import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resId, workId } from '../../support/identities.js';

import {
  createFileProjectionRunSerialiser,
  createRuntimeProjectionRunner,
} from '../../../src/bootstrap/index.js';
import { createEventDraft } from '../../../src/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src/persistence/index.js';
import { resourceStream } from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('constructs runtime replay with the activities-pr and delivery projections registered', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const projections = new InMemoryProjectionStore();
  const stream = resourceStream(resId('1'));
  await journal.append(stream, 0, [
    createEventDraft({
      eventId: 'pr-discovered',
      eventType: 'pr.discovered',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'observe-1',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'internal', id: 'activities-pr' },
      stream,
      payload: {
        workItemId: workId('1'),
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
    }),
  ]);
  const runner = createRuntimeProjectionRunner(journal, projections, new InMemoryCheckpointStore());

  await runner.runRegisteredOnce();

  expect(await projections.read('activities-pr', resId('1'))).toMatchObject({
    value: { headRevision: 'head-a' },
  });
  expect(await projections.list('delivery')).toEqual([]);
});

it('waits for another process projection run to finish before starting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-projection-lock-'));
  const first = createFileProjectionRunSerialiser(root);
  const second = createFileProjectionRunSerialiser(root);
  let notifyFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirstStarted = resolve;
  });
  let releaseFirst: (() => void) | undefined;
  let secondStarted = false;

  const firstRun = first(async () => {
    notifyFirstStarted?.();
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  });
  await firstStarted;
  const secondRun = second(async () => {
    secondStarted = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(secondStarted).toBe(false);
  releaseFirst?.();
  await Promise.all([firstRun, secondRun]);
  expect(secondStarted).toBe(true);
});
