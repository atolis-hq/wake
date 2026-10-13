import type { EventJournal } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';

/** One-shot storage faults and barriers around real durable appends. */
export class FaultInjectingJournal extends InMemoryEventJournal {
  failBefore: string | undefined;
  failAfter: string | undefined;
  beforeAppend:
    | { readonly eventType: string; readonly reached: () => void; readonly release: Promise<void> }
    | undefined;

  override async appendToStream(...args: Parameters<EventJournal['appendToStream']>) {
    const types = args[2].map((draft) => draft.eventType);
    if (this.beforeAppend !== undefined && types.includes(this.beforeAppend.eventType)) {
      const barrier = this.beforeAppend;
      this.beforeAppend = undefined;
      barrier.reached();
      await barrier.release;
    }
    if (this.failBefore !== undefined && types.includes(this.failBefore)) {
      this.failBefore = undefined;
      throw new Error('Injected storage failure before append');
    }
    const result = await super.appendToStream(...args);
    if (this.failAfter !== undefined && types.includes(this.failAfter)) {
      this.failAfter = undefined;
      throw new Error('Injected storage failure after append');
    }
    return result;
  }
}
