import { createHash } from 'node:crypto';
import { createGitHubEventData } from '../contracts/event-factory.js';
import { GitHubEventType, type GitHubAdapterEventData } from '../contracts/events.js';
import type { PullRequestObservationCache } from './pr-observation-cache.js';

export async function consecutivePullRequestObservations(
  drafts: readonly GitHubAdapterEventData[],
  cache: PullRequestObservationCache | undefined,
): Promise<GitHubAdapterEventData[]> {
  if (cache === undefined) return [...drafts];
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
    const observed = await cache.latest(key);
    if (observed !== undefined) latest.set(key, observed);
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
