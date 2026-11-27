import {
  decodeOnce,
  foldedJournalView,
  type EventEnvelope,
  type EventJournal,
  type JournalView,
  type ViewSnapshotCodec,
} from '@atolis-hq/eventing';
import {
  ResourceEventType,
  decodeResourceEvent,
  selectResourceEvent,
  type ResourceEvent,
  type ResourceEventData,
} from '../contracts/events.js';
import type { ResourceId } from '../contracts/identifiers.js';
import { resourceStream } from '../contracts/streams.js';
import { ResourceCorrelationRole } from '../contracts/vocabulary.js';
import { foldResource, type FoldedResource } from '../domain/resource.js';

export interface LoadedResource {
  readonly sequence: number;
  readonly resource: FoldedResource | null;
}

const selectResource = decodeOnce(selectResourceEvent);

export class ResourceRepository {
  private readonly resourceIds: JournalView<readonly ResourceId[]>;
  private readonly attention: JournalView<ResourceAttention>;

  constructor(private readonly journal: EventJournal) {
    this.resourceIds = foldedJournalView(journal, {
      name: 'resource-ids',
      initial: [],
      extend: extendResourceIds,
      persist: { schemaVersion: 1, codec: resourceIdsCodec },
    });
    this.attention = foldedJournalView(journal, {
      name: 'resource-attention',
      initial: noAttention,
      extend: extendAttention,
      persist: { schemaVersion: 1, codec: attentionCodec },
    });
  }

  async load(resourceId: ResourceId): Promise<LoadedResource> {
    const events = await this.journal.readStream(resourceStream(resourceId));
    const owned = events.map(selectResource).filter((event) => event !== null);
    return { sequence: events.length, resource: foldResource(owned) };
  }

  async append(
    resourceId: ResourceId,
    expectedSequence: number,
    drafts: readonly ResourceEventData[],
  ): Promise<readonly ResourceEvent[]> {
    const events = await this.journal.appendToStream(
      resourceStream(resourceId),
      expectedSequence,
      drafts,
    );
    return events.map(decodeResourceEvent);
  }

  async listResourceIds(): Promise<readonly ResourceId[]> {
    return this.resourceIds.get();
  }

  // Resources that may have an unresolved correlation retry. Callers re-check
  // the folded resource, so this only has to be a superset; it spares them
  // folding every resource stream on each pass.
  async listRetryCandidateIds(): Promise<readonly ResourceId[]> {
    return [...(await this.attention.get()).retry];
  }

  // Resources that may hold an unconsumed external outcome (same contract).
  async listPendingOutcomeCandidateIds(): Promise<readonly ResourceId[]> {
    return [...(await this.attention.get()).outcome];
  }
}

interface ResourceAttention {
  readonly retry: ReadonlySet<ResourceId>;
  readonly outcome: ReadonlySet<ResourceId>;
}

const noAttention: ResourceAttention = { retry: new Set(), outcome: new Set() };

function idList(raw: unknown): ResourceId[] {
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string'))
    throw new Error('Resource snapshot must be a list of ids');
  return raw as ResourceId[];
}

const resourceIdsCodec: ViewSnapshotCodec<readonly ResourceId[]> = {
  encode: (ids) => ids,
  decode: idList,
};

const attentionCodec: ViewSnapshotCodec<ResourceAttention> = {
  encode: (attention) => ({ retry: [...attention.retry], outcome: [...attention.outcome] }),
  decode(raw) {
    const { retry, outcome } = raw as { retry: unknown; outcome: unknown };
    return { retry: new Set(idList(retry)), outcome: new Set(idList(outcome)) };
  },
};

function extendAttention(
  known: ResourceAttention,
  events: readonly EventEnvelope[],
): ResourceAttention {
  const retry = new Set(known.retry);
  const outcome = new Set(known.outcome);
  for (const owned of events.map(selectResourceEvent)) {
    if (owned === null) continue;
    const id = owned.stream.id as ResourceId;
    switch (owned.event.eventType) {
      case ResourceEventType.WorkCorrelationRetryPending:
        retry.add(id);
        break;
      case ResourceEventType.WorkCorrelationUnresolvable:
        retry.delete(id);
        break;
      case ResourceEventType.WorkCorrelationEstablished:
        if (owned.event.payload.role === ResourceCorrelationRole.Primary) retry.delete(id);
        break;
      case ResourceEventType.ExternalOutcomeObserved:
        outcome.add(id);
        break;
      case ResourceEventType.ExternalOutcomeReopened:
      case ResourceEventType.ExternalOutcomeConsumed:
        outcome.delete(id);
        break;
      default:
        break;
    }
  }
  return { retry, outcome };
}

function extendResourceIds(
  known: readonly ResourceId[],
  events: readonly EventEnvelope[],
): readonly ResourceId[] {
  const discovered = events
    .map(selectResourceEvent)
    .filter((event) => event?.event.eventType === ResourceEventType.ResourceDiscovered)
    .map((event) => event!.stream.id);
  return [...new Set([...known, ...discovered])];
}
