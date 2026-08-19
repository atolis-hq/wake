import { expect, it } from 'vitest';
import { PollService } from '../../../src/integrations/application/poll-service.js';
import { integrationStream } from '../../../src/integrations/contracts/streams.js';
import { createEventDraft } from '../../../src/kernel/index.js';
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

it('does not commit a provider cursor when evidence persistence fails', async () => {
  const delegate = new InMemoryEventJournal(new FakeClock());
  let committed = 0;
  const journal = {
    readAll: delegate.readAll.bind(delegate),
    readStream: delegate.readStream.bind(delegate),
    latestGlobalPosition: delegate.latestGlobalPosition.bind(delegate),
    changeSignal: delegate.changeSignal,
    async append() {
      throw new Error('disk unavailable');
    },
  };
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

  await expect(service.pollOnce(new AbortController().signal)).rejects.toThrow('disk unavailable');

  expect(committed).toBe(0);
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

function draft() {
  return createEventDraft({
    eventId: 'github:issue:owner/repo#1:revision',
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
