import type { EventJournal } from '@atolis-hq/eventing';
import type { AdapterId } from '../../contracts/identifiers.js';
import {
  latestPullRequestObservation,
  pullRequestObservationOf,
} from '../application/latest-pull-request-observation.js';
import type { GitHubAdapterEventData } from '../contracts/events.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';

const CATCH_UP_PAGE = 500;
// Beyond these the cache resets and re-reads through the indexed path.
const MAX_CATCH_UP_ROWS = 5000;
const MAX_KEYS = 5000;

export interface PullRequestObservationCache {
  latest(externalKey: string): Promise<GitHubAdapterEventData | undefined>;
}

/**
 * Journal-backed memo of the latest observation per PR. It holds only durable
 * evidence and advances from events past the last position it has seen, so a
 * restart or another writer is picked up as ordinary new events.
 */
export function createPullRequestObservationCache(
  journal: EventJournal | undefined,
  adapter: AdapterId = GitHubAdapter,
): PullRequestObservationCache | undefined {
  return journal === undefined ? undefined : cacheOver(journal, adapter);
}

function cacheOver(journal: EventJournal, adapter: AdapterId): PullRequestObservationCache {
  let entries = new Map<string, GitHubAdapterEventData | null>();
  let seen: number | undefined;

  const reset = () => {
    entries = new Map();
    seen = undefined;
  };

  async function catchUp(): Promise<void> {
    const head = await journal.latestGlobalPosition();
    if (seen === undefined || head < seen) {
      reset();
      seen = head;
      return;
    }
    let cursor = seen;
    let rows = 0;
    while (cursor < head) {
      const batch = await journal.readAll(cursor, CATCH_UP_PAGE);
      if (batch.length === 0) break;
      rows += batch.length;
      for (const envelope of batch) {
        const observed = pullRequestObservationOf(envelope, adapter);
        const key = observed?.event.payload.externalKey;
        if (observed === undefined || key === undefined) continue;
        const known = entries.get(key);
        // Unknown keys are filled by the indexed read, which sees this event too.
        if (known !== undefined) entries.set(key, observed.event);
      }
      cursor = batch.at(-1)!.globalPosition;
      if (rows > MAX_CATCH_UP_ROWS && cursor < head) {
        reset();
        seen = head;
        return;
      }
    }
    seen = Math.max(head, cursor);
  }

  return {
    async latest(externalKey) {
      await catchUp();
      if (entries.size >= MAX_KEYS) entries = new Map();
      const known = entries.get(externalKey);
      if (known !== undefined) return known ?? undefined;
      // `seen` was captured before this read, so anything newer is re-folded next time.
      const found = await latestPullRequestObservation(journal, adapter, externalKey);
      entries.set(externalKey, found?.event ?? null);
      return found?.event;
    },
  };
}
