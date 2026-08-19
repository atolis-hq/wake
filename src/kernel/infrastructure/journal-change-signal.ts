import type { JournalChangeSignal } from '../contracts/journal-change-signal.js';

// Advisory-only, in-process wake-up notification for a single-writer event
// journal. Carries no payload — every caller re-derives "what changed" from
// its own durable checkpoint, which is what makes a missed, duplicated, or
// coalesced notification safe: it can only make a consumer wait up to
// fallbackMs longer than it needed to, never miss an event.
export class InProcessJournalChangeSignal implements JournalChangeSignal {
  private waiters: Array<() => void> = [];

  notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  waitForChange(signal: AbortSignal, fallbackMs: number): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        // Must drop this waiter on a timeout/abort resolution, not just on
        // notify() draining the list — otherwise every idle wait (the
        // overwhelmingly common case) leaks one entry into `waiters`
        // forever, since notify() is the only other place the list shrinks.
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        resolve();
      };
      this.waiters.push(done);
      const timer = setTimeout(done, fallbackMs);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
