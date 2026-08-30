import { describe, expect, it } from 'vitest';

import {
  BuiltInAdapterId,
  createEventData,
  type ExternalEventSource,
  integrationStream,
  PollService,
} from '../../../src/integrations/github/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

describe('PollService', () => {
  it('appends adapter evidence before translating it', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const source: ExternalEventSource = {
      async poll() {
        return [
          createEventData({
            eventId: 'github:delivery-1',
            eventType: 'integration.github.work-observed',
            occurredAt: '2026-07-30T12:00:00.000Z',
            correlationId: 'github:delivery-1',
            causationId: 'github:delivery-1',
            actor: { kind: 'integration', id: 'github' },
            source: { kind: 'adapter', id: 'github' },
            stream: integrationStream(BuiltInAdapterId.GitHub),
            payload: {
              externalKey: 'owner/repo#7',
              kind: 'issue',
              title: 'Issue 7',
              body: '',
              state: 'open',
              revision: 'revision-1',
              actor: { id: 'octocat', kind: 'human' },
              raw: {},
            },
          }),
        ];
      },
    };

    await new PollService(journal, source).pollOnce(new AbortController().signal);

    expect((await journal.readAll(0)).map((event) => event.eventType)).toEqual([
      'integration.github.work-observed',
    ]);
  });

  it('reads the integration stream once and appends a whole GitHub poll batch atomically', async () => {
    const delegate = new InMemoryEventJournal(new FakeClock());
    let reads = 0;
    const journal = {
      append: delegate.append.bind(delegate),
      readAll: delegate.readAll.bind(delegate),
      readStream: async (stream: Parameters<typeof delegate.readStream>[0]) => {
        reads += 1;
        return delegate.readStream(stream);
      },
      latestGlobalPosition: delegate.latestGlobalPosition.bind(delegate),
      waitForEventsAfter: delegate.waitForEventsAfter.bind(delegate),
      changeSignal: delegate.changeSignal,
    };
    const draft = (id: string) =>
      createEventData({
        eventId: id,
        eventType: 'integration.github.work-observed',
        occurredAt: '2026-07-30T12:00:00.000Z',
        correlationId: id,
        causationId: id,
        actor: { kind: 'integration', id: 'github' },
        source: { kind: 'adapter', id: 'github' },
        stream: integrationStream(BuiltInAdapterId.GitHub),
        payload: {
          externalKey: `owner/repo#${id}`,
          kind: 'issue' as const,
          title: id,
          body: '',
          state: 'open' as const,
          revision: id,
          actor: { id: 'octocat', kind: 'human' as const },
          raw: {},
        },
      });

    await new PollService(journal, { poll: async () => [draft('1'), draft('2')] }).pollOnce(
      new AbortController().signal,
    );

    expect(reads).toBe(1);
    expect(await delegate.readAll(0)).toHaveLength(2);
  });
});
