import { createEventData } from '@atolis-hq/eventing';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { type ExternalEventSource, PollService } from '../../../src/integrations/github/index.js';
import { FileEventJournal } from '../../../src/persistence/index.js';
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

    expect((await journal.readAll(0)).map((event) => event.event.eventType)).toEqual([
      'integration.github.work-observed',
    ]);
  });

  it('reads the integration stream once and appends a whole GitHub poll batch atomically', async () => {
    const delegate = new InMemoryEventJournal(new FakeClock());
    let reads = 0;
    const journal = {
      appendToStream: delegate.appendToStream.bind(delegate),
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

  it('deduplicates identical GitHub evidence within one poll batch', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const draft = createEventData({
      eventId: 'github:duplicate-in-batch',
      eventType: 'integration.github.work-observed',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'github:duplicate-in-batch',
      causationId: 'github:duplicate-in-batch',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      payload: {
        externalKey: 'owner/repo#duplicate',
        kind: 'issue' as const,
        title: 'Duplicate',
        body: '',
        state: 'open' as const,
        revision: 'revision-1',
        actor: { id: 'octocat', kind: 'human' as const },
        raw: {},
      },
    });

    await new PollService(journal, { poll: async () => [draft, draft] }).pollOnce(
      new AbortController().signal,
    );

    await expect(journal.readAll(0)).resolves.toHaveLength(1);
  });

  it('persists GitHub evidence through the strict file journal without adding stream to EventData', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-github-poll-file-journal-'));
    const journal = new FileEventJournal(root, new FakeClock());
    const draft = createEventData({
      eventId: 'github:file-journal-1',
      eventType: 'integration.github.work-observed',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'github:file-journal-1',
      causationId: 'github:file-journal-1',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      payload: {
        externalKey: 'owner/repo#8',
        kind: 'issue' as const,
        title: 'Issue 8',
        body: '',
        state: 'open' as const,
        revision: 'revision-1',
        actor: { id: 'octocat', kind: 'human' as const },
        raw: {},
      },
    });

    await new PollService(journal, { poll: async () => [draft] }).pollOnce(
      new AbortController().signal,
    );

    await expect(new FileEventJournal(root, new FakeClock()).readAll(0)).resolves.toEqual([
      expect.objectContaining({
        event: draft,
        stream: { kind: 'integration', id: 'github' },
      }),
    ]);
  });
});
