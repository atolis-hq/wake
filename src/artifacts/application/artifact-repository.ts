import type { EventJournal } from '@atolis-hq/eventing';
import {
  decodeArtifactEvent,
  selectArtifactEvent,
  type ArtifactEvent,
  type ArtifactEventData,
} from '../contracts/events.js';
import type { ArtifactWorkItemId } from '../contracts/identifiers.js';
import { artifactWorkItemStream } from '../contracts/streams.js';
import type { ArtifactWorkItemView } from '../contracts/views.js';
import { foldArtifactWorkItem } from '../domain/artifact-work-item.js';

export class ArtifactRepository {
  constructor(private readonly journal: EventJournal) {}

  async load(id: ArtifactWorkItemId) {
    const events = await this.journal.readStream(artifactWorkItemStream(id));
    return {
      sequence: events.length,
      view: foldArtifactWorkItem(
        events.map(selectArtifactEvent).filter((event): event is ArtifactEvent => event !== null),
      ),
    } satisfies { readonly sequence: number; readonly view: ArtifactWorkItemView | null };
  }

  async append(id: ArtifactWorkItemId, sequence: number, drafts: readonly ArtifactEventData[]) {
    return (await this.journal.appendToStream(artifactWorkItemStream(id), sequence, drafts)).map(
      decodeArtifactEvent,
    );
  }
}
