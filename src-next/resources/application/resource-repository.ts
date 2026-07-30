import {
  entityRef,
  type EventDraft,
  type EventEnvelope,
  type EventJournal,
} from '../../kernel/index.js';
import type { ExternalResourceKey } from '../contracts/views.js';
import type { ResourceId } from '../contracts/identifiers.js';
import { foldResource, type FoldedResource } from '../domain/resource.js';

export interface LoadedResource {
  readonly sequence: number;
  readonly resource: FoldedResource | null;
}

export class ResourceRepository {
  constructor(private readonly journal: EventJournal) {}

  async load(resourceId: ResourceId): Promise<LoadedResource> {
    const events = await this.journal.readStream(entityRef('resource', resourceId));
    return { sequence: events.length, resource: foldResource(events) };
  }

  append(
    resourceId: ResourceId,
    expectedSequence: number,
    drafts: readonly EventDraft[],
  ): Promise<readonly EventEnvelope[]> {
    return this.journal.append(entityRef('resource', resourceId), expectedSequence, drafts);
  }

  async findByExternalKey(externalKey: ExternalResourceKey): Promise<FoldedResource | null> {
    const events = await this.journal.readAll(0);
    const ids = new Set(
      events
        .filter((event) => event.eventType === 'resources.resource-discovered')
        .map((event) => event.stream.id),
    );
    for (const id of ids) {
      const resource = await this.load(id as ResourceId);
      if (
        resource.resource?.view.externalKey.adapter === externalKey.adapter &&
        resource.resource.view.externalKey.key === externalKey.key
      )
        return resource.resource;
    }
    return null;
  }
}
