import type { EventJournal } from '@atolis-hq/eventing';
import type { AdapterId } from '../../contracts/identifiers.js';
import { integrationStream } from '../../contracts/streams.js';
import {
  GitHubEventType,
  selectGitHubAdapterEvent,
  type GitHubAdapterEventOf,
} from '../contracts/events.js';

type PullRequestObservation = GitHubAdapterEventOf<typeof GitHubEventType.WorkObserved>;

const PAGE = 50;

/** The pull-request observation an envelope carries on this adapter's stream, if any. */
export function pullRequestObservationOf(
  envelope: Awaited<ReturnType<EventJournal['readStream']>>[number],
  adapter: AdapterId,
): PullRequestObservation | undefined {
  const stream = integrationStream(adapter);
  if (envelope.stream.kind !== stream.kind || envelope.stream.id !== stream.id) return undefined;
  const owned = selectGitHubAdapterEvent(envelope);
  return owned?.event.eventType === GitHubEventType.WorkObserved &&
    owned.event.payload.kind === 'pull-request'
    ? (owned as PullRequestObservation)
    : undefined;
}

/**
 * Latest observation of one pull request. The integration stream grows without
 * bound, so journals with a payload index answer this without reading the stream.
 */
export async function latestPullRequestObservation(
  journal: EventJournal,
  adapter: AdapterId,
  externalKey: string,
): Promise<PullRequestObservation | undefined> {
  const stream = integrationStream(adapter);
  const accept = (envelope: Awaited<ReturnType<EventJournal['readStream']>>[number]) => {
    const owned = pullRequestObservationOf(envelope, adapter);
    return owned?.event.payload.externalKey === externalKey ? owned : undefined;
  };
  if (journal.readLatestMatching === undefined) {
    let latest: PullRequestObservation | undefined;
    for (const envelope of await journal.readStream(stream)) latest = accept(envelope) ?? latest;
    return latest;
  }
  let before: number | undefined;
  for (;;) {
    // An empty stream id leaves only the payload match, which may span streams.
    const batch = await journal.readLatestMatching(
      { streamId: '', payloadField: 'externalKey', payloadValue: externalKey },
      before,
      PAGE,
    );
    for (const envelope of batch) {
      const found = accept(envelope);
      if (found !== undefined) return found;
    }
    const oldest = batch.at(-1);
    if (oldest === undefined || batch.length < PAGE) return undefined;
    before = oldest.globalPosition;
  }
}
