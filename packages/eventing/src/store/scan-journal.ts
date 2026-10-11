import type { EventJournal } from './event-journal.js';

/** A bounded snapshot scan that gives hosts time to serve other work between batches. */
export async function* scanJournal(journal: EventJournal, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (journal.scanAll !== undefined) {
    for await (const event of journal.scanAll(signal)) {
      signal?.throwIfAborted();
      yield event;
    }
    signal?.throwIfAborted();
    return;
  }
  const end = await journal.latestGlobalPosition();
  let position = 0;
  while (position < end) {
    await yieldScan(signal);
    const batch = await journal.readAll(position, 100);
    signal?.throwIfAborted();
    if (batch.length === 0) return;
    for (const event of batch) {
      signal?.throwIfAborted();
      if (event.globalPosition > end) return;
      yield event;
      position = event.globalPosition;
    }
  }
  signal?.throwIfAborted();
}

export async function yieldScan(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}
