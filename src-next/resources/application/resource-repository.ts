import type { EventJournal } from '../../kernel/index.js';
import {
  decodeResourceEvent,
  selectResourceEvent,
  type ResourceEvent,
  type ResourceEventDraft,
} from '../contracts/events.js';
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
    const owned = events.map(selectResourceEvent).filter((event) => event !== null);
    return { sequence: events.length, resource: foldResource(owned) };
  }

  async append(
    resourceId: ResourceId,
    expectedSequence: number,
    drafts: readonly ResourceEventDraft[],
  ): Promise<readonly ResourceEvent[]> {
    const events = await this.journal.append(resourceStream(resourceId), expectedSequence, drafts);
    return events.map(decodeResourceEvent);
  }
}
