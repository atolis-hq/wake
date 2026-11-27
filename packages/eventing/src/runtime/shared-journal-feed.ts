import type { EventEnvelope } from '../contracts/events.js';
import type { EventJournal } from '../store/event-journal.js';

/** Bounds how many decoded envelopes a fold holds at once while catching up. */
export const JOURNAL_VIEW_PAGE_SIZE = 2_000;

/** Caps pages kept for consumers that trail the leader; laggards past it re-read. */
const MAX_SHARED_PAGES = 16;

export type FeedJournal = Pick<EventJournal, 'readAll' | 'latestGlobalPosition'>;

/**
 * Pages of `readAll` shared by every view over one journal, so N views catching
 * up from the same position cost one read of each page. Only full pages are
 * retained (a full page after a position is immutable in an append-only
 * journal); a short tail page is shared only while its read is in flight. Pages
 * are dropped when no catch-up is running, and all of them when the head moves
 * backwards (journal restore).
 */
export class SharedJournalFeed {
  private readonly pages = new Map<number, Promise<readonly EventEnvelope[]>>();
  private lastHead = 0;
  private active = 0;

  constructor(private readonly journal: FeedJournal) {}

  async head(): Promise<number> {
    const head = await this.journal.latestGlobalPosition();
    if (head < this.lastHead) this.pages.clear();
    this.lastHead = head;
    return head;
  }

  async catchUp<Result>(run: () => Promise<Result>): Promise<Result> {
    this.active += 1;
    try {
      return await run();
    } finally {
      this.active -= 1;
      if (this.active === 0) this.pages.clear();
    }
  }

  page(after: number): Promise<readonly EventEnvelope[]> {
    const held = this.pages.get(after);
    if (held !== undefined) return held;
    const read = this.journal.readAll(after, JOURNAL_VIEW_PAGE_SIZE);
    this.pages.set(after, read);
    if (this.pages.size > MAX_SHARED_PAGES) this.pages.delete(this.pages.keys().next().value!);
    const forget = () => {
      if (this.pages.get(after) === read) this.pages.delete(after);
    };
    read.then((events) => {
      if (events.length < JOURNAL_VIEW_PAGE_SIZE) forget();
    }, forget);
    return read;
  }
}

const feeds = new WeakMap<object, SharedJournalFeed>();

export function sharedJournalFeed(journal: FeedJournal): SharedJournalFeed {
  let feed = feeds.get(journal);
  if (feed === undefined) {
    feed = new SharedJournalFeed(journal);
    feeds.set(journal, feed);
  }
  return feed;
}
