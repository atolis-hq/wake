import type { EventJournal } from '@atolis-hq/eventing';
import { createHash } from 'node:crypto';
import type { AdapterId } from '../../contracts/identifiers.js';
import { integrationStream } from '../../contracts/streams.js';
import { createGitHubEventData } from '../contracts/event-factory.js';
import {
  GitHubEventType,
  selectGitHubAdapterEvent,
  type GitHubAdapterEventData,
} from '../contracts/events.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';

export async function consecutivePullRequestObservations(
  drafts: readonly GitHubAdapterEventData[],
  journal: EventJournal | undefined,
  adapter: AdapterId | undefined,
): Promise<GitHubAdapterEventData[]> {
  if (journal === undefined) return [...drafts];
  const latest = new Map<string, GitHubAdapterEventData>();
  for (const envelope of await journal.readStream(integrationStream(adapter ?? GitHubAdapter))) {
    const event = selectGitHubAdapterEvent(envelope)?.event;
    if (event?.eventType === GitHubEventType.WorkObserved && event.payload.kind === 'pull-request')
      latest.set(event.payload.externalKey, event);
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
