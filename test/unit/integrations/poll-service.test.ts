import { expect, it } from 'vitest';
import { PollService } from '../../../src/integrations/application/poll-service.js';
import { integrationStream } from '../../../src/integrations/contracts/streams.js';
import { createEventData } from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
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
    async append(
      stream: Parameters<typeof delegate.append>[0],
      sequence: number,
      events: Parameters<typeof delegate.append>[2],
    ) {
      if (events[0]?.eventId === 'github:issue:owner/repo#1:revision')
        throw new Error('disk unavailable');
      return delegate.append(stream, sequence, events);
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
    stream: integrationStream('github' as never),
    payload: { externalKey: 'owner/repo#1' },
  });
}
