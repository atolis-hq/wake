export interface JournalChangeSignal {
  // Resolves as soon as a change has been signalled since this call started,
  // or after fallbackMs elapses, or if the signal aborts — whichever first.
  // Never rejects. Coalesces: any number of notify() calls between
  // waitForChange() calls produce exactly one wake-up, not one per call.
  waitForChange(signal: AbortSignal, fallbackMs: number): Promise<void>;
}
