import type { EventJournal } from '@atolis-hq/eventing';
import { createHash } from 'node:crypto';
import type { AdapterId } from '../../contracts/identifiers.js';
import { latestPullRequestObservation } from '../application/latest-pull-request-observation.js';
import { createGitHubEventData } from '../contracts/event-factory.js';
import { GitHubEventType, type GitHubAdapterEventData } from '../contracts/events.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';

export async function consecutivePullRequestObservations(
  drafts: readonly GitHubAdapterEventData[],
  journal: EventJournal | undefined,
  adapter: AdapterId | undefined,
): Promise<GitHubAdapterEventData[]> {
  if (journal === undefined) return [...drafts];
  // Most polls carry no PR evidence; they must not touch the unbounded stream at all.
  const keys = new Set(
    drafts.flatMap((draft) =>
      draft.eventType === GitHubEventType.WorkObserved && draft.payload.kind === 'pull-request'
        ? [draft.payload.externalKey]
        : [],
    ),
  );
  const latest = new Map<string, GitHubAdapterEventData>();
  for (const key of keys) {
    const observed = await latestPullRequestObservation(journal, adapter ?? GitHubAdapter, key);
    if (observed !== undefined) latest.set(key, observed.event);
  }
  return drafts.flatMap((draft) => {
    if (draft.eventType !== GitHubEventType.WorkObserved || draft.payload.kind !== 'pull-request')
      return [draft];
    const prior = latest.get(draft.payload.externalKey);
    if (prior?.causationId === draft.causationId) return [];
    // Chain to durable evidence: replay stays stable, but recurring states get new identities.
    const event = createGitHubEventData({
      ...draft,
      eventId:
        draft.eventId +
        ':' +
        createHash('sha256')
          .update(prior?.eventId ?? '')
          .digest('hex'),
    });
    latest.set(draft.payload.externalKey, event);
    return [event];
  });
}
