import type { EventDraft, EventEnvelope, EventJournal } from '../../kernel/index.js';
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
    return { sequence: events.length, view: foldWorkItem(events) };
  }

  append(
    workItemId: WorkItemId,
    expectedSequence: number,
    drafts: readonly EventDraft[],
  ): Promise<readonly EventEnvelope[]> {
    return this.journal.append(workItemStream(workItemId), expectedSequence, drafts);
  }
}
