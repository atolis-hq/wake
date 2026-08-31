import { cachedJournalView, type CachedJournalView, type EventJournal } from '@atolis-hq/eventing';
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

export class ResourceRepository {
  private readonly resourceIds: CachedJournalView<readonly ResourceId[]>;

  constructor(private readonly journal: EventJournal) {
    this.resourceIds = cachedJournalView(journal, deriveResourceIds);
  }

  async load(resourceId: ResourceId): Promise<LoadedResource> {
    const events = await this.journal.readStream(resourceStream(resourceId));
    const owned = events.map(selectResourceEvent).filter((event) => event !== null);
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

function deriveResourceIds(
  events: Awaited<ReturnType<EventJournal['readAll']>>,
): readonly ResourceId[] {
  return [
    ...new Set(
      events
        .map(selectResourceEvent)
        .filter((event) => event?.event.eventType === ResourceEventType.ResourceDiscovered)
        .map((event) => event!.stream.id),
    ),
  ];
}
