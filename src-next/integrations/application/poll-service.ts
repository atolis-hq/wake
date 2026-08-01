import type { EventJournal } from '../../kernel/index.js';
import type { ProviderInstance } from '../contracts/provider.js';
import { integrationStream } from '../contracts/streams.js';

export class PollService {
  constructor(
    private readonly journal: EventJournal,
    private readonly instance: ProviderInstance,
  ) {}

  async pollOnce(signal: AbortSignal): Promise<void> {
    const drafts = await this.instance.source.poll(signal);
    for (const draft of drafts) {
      if (!this.instance.eventTypes.includes(draft.eventType))
        throw new Error(`Provider ${this.instance.adapter} emitted an unknown event type`);
      const stream = integrationStream(this.instance.adapter);
      const existing = await this.journal.readStream(stream);
      if (existing.some((event) => event.eventId === draft.eventId)) continue;
      await this.journal.append(stream, existing.length, [{ ...draft, stream }]);
    }
  }
}
