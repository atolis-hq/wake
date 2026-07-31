import type { EventDraft, EventEnvelope, EventJournal } from '../../kernel/index.js';
import type { ExternalResourceKey } from '../contracts/views.js';
import type { ResourceId } from '../contracts/identifiers.js';
import { resourceStream } from '../contracts/streams.js';
import { foldResource, type FoldedResource } from '../domain/resource.js';

export interface LoadedResource {
  readonly sequence: number;
  readonly resource: FoldedResource | null;
}

export class ResourceRepository {
  constructor(private readonly journal: EventJournal) {}

  async load(resourceId: ResourceId): Promise<LoadedResource> {
    const events = await this.journal.readStream(resourceStream(resourceId));
    return { sequence: events.length, resource: foldResource(events) };
  }

  append(
    resourceId: ResourceId,
    expectedSequence: number,
    drafts: readonly EventDraft[],
  ): Promise<readonly EventEnvelope[]> {
    return this.journal.append(resourceStream(resourceId), expectedSequence, drafts);
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
