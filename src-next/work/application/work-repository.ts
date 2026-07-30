import {
  entityRef,
  type EventDraft,
  type EventEnvelope,
  type EventJournal,
} from '../../kernel/index.js';
import { foldWorkItem } from '../domain/work-item.js';
import type { WorkItemId } from '../contracts/identifiers.js';
import type { WorkItemView } from '../contracts/views.js';

export interface LoadedWorkItem {
  readonly sequence: number;
  readonly view: WorkItemView | null;
}

export class WorkRepository {
  constructor(private readonly journal: EventJournal) {}

  async load(workItemId: WorkItemId): Promise<LoadedWorkItem> {
    const events = await this.journal.readStream(entityRef('work-item', workItemId));
    return { sequence: events.length, view: foldWorkItem(events) };
  }

  append(
    workItemId: WorkItemId,
    expectedSequence: number,
    drafts: readonly EventDraft[],
  ): Promise<readonly EventEnvelope[]> {
    return this.journal.append(entityRef('work-item', workItemId), expectedSequence, drafts);
  }
}
