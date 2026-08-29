export interface JournalChangeSignal {
  // A process-local monotonically increasing revision. Consumers use it to
  // avoid probing the journal again when no local append has occurred.
  revision(): number;

  waitForChangeAfter(
    observedGeneration: number,
    signal: AbortSignal,
    fallbackMs: number,
  ): Promise<void>;

  // Resolves as soon as a change has been signalled since this call started,
  // or after fallbackMs elapses, or if the signal aborts — whichever first.
  // Never rejects. Coalesces: any number of notify() calls between
  // waitForChange() calls produce exactly one wake-up, not one per call.
  waitForChange(signal: AbortSignal, fallbackMs: number): Promise<void>;
}
