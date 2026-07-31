import { describe, expect, it } from 'vitest';

import {
  PollService,
  BuiltInAdapterId,
  createEventDraft,
  type ExternalEventSource,
  integrationStream,
} from '../../src-next/integrations/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import { FakeClock } from '../e2e/support/world.js';

describe('PollService', () => {
  it('appends adapter evidence before translating it', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const source: ExternalEventSource = {
      async poll() {
        return [
          createEventDraft({
            eventId: 'github:delivery-1',
            eventType: 'integration.github.work-observed',
            occurredAt: '2026-07-30T12:00:00.000Z',
            correlationId: 'github:delivery-1',
            causationId: 'github:delivery-1',
            actor: { kind: 'integration', id: 'github' },
            source: { kind: 'adapter', id: 'github' },
            stream: integrationStream(BuiltInAdapterId.GitHub),
            payload: { externalKey: 'owner/repo#7' },
          }),
        ];
      },
    };

    await new PollService(journal, source).pollOnce(new AbortController().signal);

    expect((await journal.readAll(0)).map((event) => event.eventType)).toEqual([
      'integration.github.work-observed',
    ]);
  });
});
