import { expect, it } from 'vitest';

import { createRuntimeProjectionRunner } from '../../src-next/bootstrap/index.js';
import { createEventDraft } from '../../src-next/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../src-next/persistence/index.js';
import { resourceId, resourceStream } from '../../src-next/resources/index.js';
import { FakeClock } from '../e2e/support/world.js';

it('constructs runtime replay with the activities-pr and delivery projections registered', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const projections = new InMemoryProjectionStore();
  const stream = resourceStream(resourceId('resource-1'));
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
        workItemId: 'work-1',
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
    }),
  ]);
  const runner = createRuntimeProjectionRunner(journal, projections, new InMemoryCheckpointStore());

  await runner.runRegisteredOnce();

  expect(await projections.read('activities-pr', 'resource-1')).toMatchObject({
    value: { headRevision: 'head-a' },
  });
  expect(await projections.list('delivery')).toEqual([]);
});
