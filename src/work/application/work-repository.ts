import type { EventJournal } from '../../kernel/index.js';
import {
  decodeWorkEvent,
  selectWorkEvent,
  type WorkEvent,
  type WorkEventData,
} from '../contracts/events.js';
import type { WorkItemId } from '../contracts/identifiers.js';
import { workItemStream } from '../contracts/streams.js';
import type { WorkItemView } from '../contracts/views.js';
import { foldWorkItem } from '../domain/work-item.js';

export interface LoadedWorkItem {
  readonly sequence: number;
  readonly view: WorkItemView | null;
}

export class WorkRepository {
  constructor(private readonly journal: EventJournal) {}

  async load(workItemId: WorkItemId): Promise<LoadedWorkItem> {
    const events = await this.journal.readStream(workItemStream(workItemId));
    const owned = events.map(selectWorkEvent).filter((event) => event !== null);
    return { sequence: events.length, view: foldWorkItem(owned) };
  }

  async append(
    workItemId: WorkItemId,
    expectedSequence: number,
    drafts: readonly WorkEventData[],
  ): Promise<readonly WorkEvent[]> {
    const events = await this.journal.appendToStream(
      workItemStream(workItemId),
      expectedSequence,
      drafts,
    );
    return events.map(decodeWorkEvent);
  }
}
