import {
  decodeOnce,
  foldedJournalView,
  type EventEnvelope,
  type EventJournal,
  type JournalView,
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
import { foldResource, type FoldedResource } from '../domain/resource.js';

export interface LoadedResource {
  readonly sequence: number;
  readonly resource: FoldedResource | null;
}

const selectResource = decodeOnce(selectResourceEvent);

export class ResourceRepository {
  private readonly resourceIds: JournalView<readonly ResourceId[]>;

  constructor(private readonly journal: EventJournal) {
    this.resourceIds = foldedJournalView(journal, { initial: [], extend: extendResourceIds });
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
