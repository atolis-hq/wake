import { WrongExpectedSequenceError, type EventData, type EventJournal } from '@atolis-hq/eventing';
import type { ProviderInstance } from '../contracts/provider.js';
import { integrationStream } from '../contracts/streams.js';

export interface PollResult {
  readonly appended: number;
  readonly failed: number;
}

export class PollService {
  // Kept across polls: the stream is read once per process, then tracked as we
  // append. A concurrent writer is caught by the sequence check and reloaded.
  private ledger: StreamLedger | undefined;

  constructor(
    private readonly journal: EventJournal,
    private readonly instance: ProviderInstance,
  ) {}

  /** Persists every independently durable draft and reports partial progress. */
  async pollOnce(
    signal: AbortSignal,
    options?: { readonly bypassInterval?: boolean },
  ): Promise<PollResult> {
    const adapter = this.instance.adapter;
    const drafts = await this.instance.source.poll(signal, options);
    let appended = 0;
    let failed = 0;
    // The stream grows without bound: re-reading it per draft or per poll makes
    // a poll cost history, which outlives its deadline.
    const ledger = (this.ledger ??= new StreamLedger(this.journal, integrationStream(adapter)));
    for (const draft of drafts) {
      // A run past its deadline may be leaked; it must not persist or advance state.
      if (signal.aborted) return { appended, failed: failed + 1 };
      try {
        if (!this.instance.eventTypes.includes(draft.eventType))
          throw new Error(`Provider ${adapter} emitted an unknown event type`);
        if (await ledger.append(draft)) appended += 1;
      } catch (error) {
        failed += 1;
        ledger.invalidate();
        console.error(`Polling ${adapter} could not persist ${draft.eventId}`, error);
      }
    }
    if (failed === 0 && !signal.aborted) await this.instance.source.markPollPersisted?.();
    return { appended, failed };
  }
}

/** Tracks one stream's event ids and tail so repeated appends need a single read. */
class StreamLedger {
  private known: { readonly ids: Set<string>; sequence: number } | undefined;

  constructor(
    private readonly journal: EventJournal,
    private readonly stream: ReturnType<typeof integrationStream>,
  ) {}

  invalidate(): void {
    this.known = undefined;
  }

  /** Returns false when the event is already in the stream. */
  async append(draft: EventData): Promise<boolean> {
    this.known ??= await this.load();
    if (this.known.ids.has(draft.eventId)) return false;
    try {
      await this.journal.appendToStream(this.stream, this.known.sequence, [draft]);
    } catch (error) {
      // Another writer moved the stream; reload once and re-check the draft.
      if (!(error instanceof WrongExpectedSequenceError)) throw error;
      this.known = await this.load();
      if (this.known.ids.has(draft.eventId)) return false;
      await this.journal.appendToStream(this.stream, this.known.sequence, [draft]);
    }
    this.known.ids.add(draft.eventId);
    this.known.sequence += 1;
    return true;
  }

  private async load() {
    const existing = await this.journal.readStream(this.stream);
    return {
      ids: new Set(existing.map((event) => event.event.eventId)),
      sequence: existing.length,
    };
  }
}
