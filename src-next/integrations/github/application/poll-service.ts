import { entityRef, type EventDraft, type EventJournal } from '../../../kernel/index.js';

export interface ExternalEventSource {
  poll(signal: AbortSignal): Promise<readonly EventDraft[]>;
}

export class PollService {
  constructor(
    private readonly journal: EventJournal,
    private readonly source: ExternalEventSource,
  ) {}

  async pollOnce(signal: AbortSignal): Promise<void> {
    const drafts = await this.source.poll(signal);
    for (const draft of drafts) {
      if (draft.source.kind !== 'adapter' || draft.source.id !== 'github') {
        throw new Error('PollService accepts GitHub adapter evidence only');
      }
      if (!draft.eventType.startsWith('integration.github.')) {
        throw new Error('PollService cannot append canonical domain events');
      }
      const stream = entityRef('integration', 'github');
      const existing = await this.journal.readStream(stream);
      await this.journal.append(stream, existing.length, [{ ...draft, stream }]);
    }
  }
}
