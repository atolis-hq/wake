import type { EventJournal } from '../../kernel/index.js';
import type { ProviderInstance } from '../contracts/provider.js';
import { integrationStream } from '../contracts/streams.js';

export interface PollResult {
  readonly appended: number;
  readonly failed: number;
}

export class PollService {
  constructor(
    private readonly journal: EventJournal,
    private readonly instance: ProviderInstance,
  ) {}

  /** Persists every independently durable draft and reports partial progress. */
  async pollOnce(signal: AbortSignal): Promise<PollResult> {
    const adapter = this.instance.adapter;
    const drafts = await this.instance.source.poll(signal);
    let appended = 0;
    let failed = 0;
    for (const draft of drafts) {
      try {
        if (!this.instance.eventTypes.includes(draft.eventType))
          throw new Error(`Provider ${adapter} emitted an unknown event type`);
        const stream = integrationStream(adapter);
        const existing = await this.journal.readStream(stream);
        if (existing.some((event) => event.event.eventId === draft.eventId)) continue;
        await this.journal.appendToStream(stream, existing.length, [draft]);
        appended += 1;
      } catch (error) {
        failed += 1;
        console.error(`Polling ${adapter} could not persist ${draft.eventId}`, error);
      }
    }
    if (failed === 0) await this.instance.source.markPollPersisted?.();
    return { appended, failed };
  }
}
