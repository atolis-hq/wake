import { describe, expect, it } from 'vitest';
import { resId, workId } from '../../support/identities.js';

import {
  createEventData,
  createProjectionProcessor,
  EventProcessorHost,
  type EventEnvelope,
} from '@atolis-hq/eventing';
import {
  activityProjectionDefinitions,
  pullRequestProjection,
} from '../../../src/activities/index.js';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src/persistence/index.js';
import { resourceStream } from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';

function event(type: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    event: createEventData({
      eventId: `event-${type}`,
      eventType: type,
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'command-1',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      payload,
    }),
    stream: resourceStream(resId('1')),
    globalPosition: 1,
    recordedAt: '2026-07-30T12:00:00.000Z',
    sequence: 1,
  };
}

describe('pullRequestProjection', () => {
  it('projects an accepted review only at its observed revision and clears it when head changes', () => {
    const discovered = pullRequestProjection.project(
      pullRequestProjection.initial(resId('1')),
      event('pr.discovered', {
        workItemId: workId('1'),
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'pending',
      }),
    );
    const accepted = pullRequestProjection.project(
      discovered,
      event('pr.review-accepted', { revision: 'head-a', actorId: 'reviewer' }),
    );
    expect(accepted?.acceptedReview).toMatchObject({ revision: 'head-a', actorId: 'reviewer' });
    const revised = pullRequestProjection.project(
      accepted,
      event('pr.revision-changed', { headRevision: 'head-b', baseRevision: 'base-a' }),
    );
    expect(revised).toMatchObject({ headRevision: 'head-b' });
    expect(revised).not.toHaveProperty('acceptedReview');
  });

  it('preserves all distinct check states', () => {
    const discovered = pullRequestProjection.project(
      pullRequestProjection.initial(resId('1')),
      event('pr.discovered', {
        workItemId: workId('1'),
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'unknown',
      }),
    );
    expect(
      pullRequestProjection.project(discovered, event('pr.checks-changed', { checks: 'failing' })),
    ).toMatchObject({ checks: 'failing' });
  });

  it('projects activities-pr through a named durable subscription', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const draft = event('pr.discovered', {
      workItemId: workId('1'),
      state: 'open',
      headRevision: 'head-a',
      baseRevision: 'base-a',
      checks: 'passing',
    });
    await journal.appendToStream(draft.stream, 0, [draft.event]);
    const store = new InMemoryProjectionStore();
    const host = new EventProcessorHost(
      journal,
      new InMemoryCheckpointStore(),
      createInMemoryProcessorRunSerialiser(),
      new FakeClock(),
    );

    expect(activityProjectionDefinitions.map((definition) => definition.name)).toContain(
      'activities-pr',
    );
    await host.runOnce(createProjectionProcessor(pullRequestProjection, store));
    expect(await store.read('activities-pr', resId('1'))).toMatchObject({
      value: { headRevision: 'head-a' },
    });
  });
});
