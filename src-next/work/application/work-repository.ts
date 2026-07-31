import type { EventJournal } from '../../kernel/index.js';
import {
  decodeWorkEvent,
  selectWorkEvent,
  type WorkEvent,
  type WorkEventDraft,
} from '../contracts/events.js';
import { foldWorkItem } from '../domain/work-item.js';
import type { WorkItemId } from '../contracts/identifiers.js';
import { workItemStream } from '../contracts/streams.js';
import type { WorkItemView } from '../contracts/views.js';

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
    drafts: readonly WorkEventDraft[],
  ): Promise<readonly WorkEvent[]> {
    const events = await this.journal.append(workItemStream(workItemId), expectedSequence, drafts);
    return events.map(decodeWorkEvent);
  }
}
