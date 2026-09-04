import type { JournalChangeSignal } from '../subscriptions/journal-change-signal.js';

export class InProcessJournalChangeSignal implements JournalChangeSignal {
  private waiters: Array<() => void> = [];
  private currentRevision = 0;

  revision(): number {
    return this.currentRevision;
  }

  notify(): void {
    this.currentRevision += 1;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  waitForChange(signal: AbortSignal, fallbackMs: number): Promise<void> {
    return this.waitForChangeAfter(this.currentRevision, signal, fallbackMs);
  }

  waitForChangeAfter(
    observedGeneration: number,
    signal: AbortSignal,
    fallbackMs: number,
  ): Promise<void> {
    if (signal.aborted || this.currentRevision !== observedGeneration) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        // Must drop this waiter here too, not just in notify() - otherwise
        // every timeout/abort leaks an entry into `waiters` forever.
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        resolve();
      };
      this.waiters.push(done);
      const timer = setTimeout(done, fallbackMs);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
