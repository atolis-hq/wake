import { createEventData } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import { PollService } from '../../../src/integrations/application/poll-service.js';
import { adapterId } from '../../../src/integrations/contracts/identifiers.js';
import { integrationStream } from '../../../src/integrations/contracts/streams.js';
import { FakeClock } from '../../e2e/support/world.js';

it('commits a provider cursor only after its evidence is durable', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  let committed = 0;
  const service = new PollService(
    journal,
    provider({
      async poll() {
        return [draft()];
      },
      async markPollPersisted() {
        committed += 1;
      },
    }),
  );

  await service.pollOnce(new AbortController().signal);

  expect(committed).toBe(1);
  expect(await journal.readAll(0)).toHaveLength(1);
});

it('continues after a persistence failure and withholds the provider cursor', async () => {
  const delegate = new InMemoryEventJournal(new FakeClock());
  let committed = 0;
  const journal = {
    readAll: delegate.readAll.bind(delegate),
    readStream: delegate.readStream.bind(delegate),
    latestGlobalPosition: delegate.latestGlobalPosition.bind(delegate),
    waitForEventsAfter: delegate.waitForEventsAfter.bind(delegate),
    changeSignal: delegate.changeSignal,
    async appendToStream(
      stream: Parameters<typeof delegate.appendToStream>[0],
      sequence: number,
      events: Parameters<typeof delegate.appendToStream>[2],
    ) {
      if (events[0]?.eventId === 'github:issue:owner/repo#1:revision')
        throw new Error('disk unavailable');
      return delegate.appendToStream(stream, sequence, events);
    },
  };
  const service = new PollService(
    journal,
    provider({
      async poll() {
        return [draft(), draft('github:issue:owner/repo#2:revision')];
      },
      async markPollPersisted() {
        committed += 1;
      },
    }),
  );

  await expect(service.pollOnce(new AbortController().signal)).resolves.toEqual({
    appended: 1,
    failed: 1,
  });

  expect(committed).toBe(0);
  expect(await delegate.readAll(0)).toHaveLength(1);
});

// The integration stream grows without bound; a poll that re-reads it per draft
// costs drafts x history and outlives its deadline on a long-lived journal.
it('reads the integration stream once per poll however many drafts it persists', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const readStream = vi.spyOn(journal, 'readStream');
  const ids = Array.from({ length: 12 }, (_, index) => `github:issue:owner/repo#${index}:revision`);
  const service = new PollService(
    journal,
    provider({
      async poll() {
        return [...ids, ids[0]!].map((id) => draft(id));
      },
      async markPollPersisted() {},
    }),
  );

  await expect(service.pollOnce(new AbortController().signal)).resolves.toEqual({
    appended: 12,
    failed: 0,
  });
  expect(readStream.mock.calls.length).toBeLessThanOrEqual(1);
  expect(await journal.readAll(0)).toHaveLength(12);

  // A repeat poll of already-persisted evidence is a single read and no appends.
  readStream.mockClear();
  await expect(service.pollOnce(new AbortController().signal)).resolves.toEqual({
    appended: 0,
    failed: 0,
  });
  expect(readStream.mock.calls.length).toBeLessThanOrEqual(1);
});

it('reads the stream once across polls and still dedupes a concurrent writer', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const readStream = vi.spyOn(journal, 'readStream');
  let next: ReturnType<typeof draft>[] = [draft('one')];
  const service = new PollService(
    journal,
    provider({ poll: async () => next, markPollPersisted: async () => undefined }),
  );

  await service.pollOnce(new AbortController().signal);
  next = [draft('one'), draft('two')];
  await service.pollOnce(new AbortController().signal);
  expect(readStream).toHaveBeenCalledTimes(1);

  // Another process appends `three`; our cached sequence is now stale.
  await journal.appendToStream(integrationStream(adapterId('github')), 2, [draft('three')]);
  next = [draft('three'), draft('four')];
  await service.pollOnce(new AbortController().signal);

  const ids = (await journal.readAll(0)).map((event) => event.event.eventId);
  expect(ids).toEqual(['one', 'two', 'three', 'four']);
});

function provider(source: {
  readonly poll: () => Promise<readonly ReturnType<typeof draft>[]>;
  readonly markPollPersisted: () => Promise<void>;
}) {
  return {
    adapter: 'github',
    eventTypes: ['integration.github.work-observed'],
    source,
  } as never;
}

function draft(eventId = 'github:issue:owner/repo#1:revision') {
  return createEventData({
    eventId,
    eventType: 'integration.github.work-observed',
    occurredAt: '2026-08-16T19:22:00.000Z',
    correlationId: 'github:owner/repo#1',
    causationId: 'github:issue:owner/repo#1:revision',
    actor: { kind: 'integration', id: 'github' },
    source: { kind: 'adapter', id: 'github' },
    payload: { externalKey: 'owner/repo#1' },
  });
}
