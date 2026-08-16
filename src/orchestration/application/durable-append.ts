import { WrongExpectedSequenceError } from '../../kernel/index.js';

/** Recover a competing append only when the caller's durable intent is now visible. */
export async function appendWithIntentRecovery<View>(input: {
  readonly append: () => Promise<void>;
  readonly load: () => Promise<View>;
  readonly alreadyApplied: (view: View) => boolean;
}): Promise<View | undefined> {
  try {
    await input.append();
    return undefined;
  } catch (error) {
    const reloaded = await input.load();
    if (input.alreadyApplied(reloaded)) return reloaded;
    throw error;
  }
}

/**
 * Append a single claim with optimistic concurrency. The claim is inspected
 * before every append, so a losing racer terminates on its next read.
 */
export async function claimWithCasRetry<Event, Decoded>(input: {
  readonly read: () => Promise<readonly Event[]>;
  readonly decode: (events: readonly Event[]) => Decoded;
  readonly alreadyClaimed: (events: Decoded) => boolean;
  readonly canAppend?: (events: readonly Event[], decoded: Decoded) => boolean;
  readonly append: (expectedSequence: number) => Promise<void>;
}): Promise<boolean> {
  for (;;) {
    const events = await input.read();
    const decoded = input.decode(events);
    if (input.alreadyClaimed(decoded)) return false;
    if (input.canAppend?.(events, decoded) === false) return false;
    try {
      await input.append(events.length);
      return true;
    } catch (error) {
      if (!(error instanceof WrongExpectedSequenceError)) throw error;
    }
  }
}
