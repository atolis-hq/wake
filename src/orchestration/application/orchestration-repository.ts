import type { EventJournal } from '../../kernel/index.js';
import { cachedJournalView, type CachedJournalView } from '../../persistence/index.js';
import {
  decodeOrchestrationEvent,
  selectWorkflowOrchestrationEvent,
} from '../contracts/event-decoder.js';
import type {
  WorkflowOrchestrationEvent,
  WorkflowOrchestrationEventDraft,
} from '../contracts/events.js';
import { workflowInstanceId } from '../contracts/identifiers.js';
import { isWorkflowInstanceStream, workflowInstanceStream } from '../contracts/streams.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { foldWorkflowInstance } from '../domain/workflow-instance.js';

type ListedInstance = { readonly sequence: number; readonly view: WorkflowInstanceView | null };

type JournalEvent = Awaited<ReturnType<EventJournal['readAll']>>[number];

export class OrchestrationRepository {
  private readonly listed: CachedJournalView<readonly ListedInstance[]>;

  constructor(private readonly journal: EventJournal) {
    this.listed = cachedJournalView(journal, (events) => deriveList(events));
  }

  async load(id: string) {
    const events = await this.journal.readStream(workflowInstanceStream(workflowInstanceId(id)));
    const owned = events
      .map(selectWorkflowOrchestrationEvent)
      .filter(
        (event): event is WorkflowOrchestrationEvent =>
          event !== null && isWorkflowInstanceStream(event.stream),
      );
    return { sequence: events.length, view: foldWorkflowInstance(owned) };
  }

  async loadRequired(id: string) {
    const loaded = await this.load(id);
    if (loaded.view === null) throw new Error('WorkflowInstance does not exist');
    return { sequence: loaded.sequence, view: loaded.view };
  }

  async append(
    id: string,
    sequence: number,
    drafts: readonly WorkflowOrchestrationEventDraft[],
  ): Promise<readonly WorkflowOrchestrationEvent[]> {
    const events = await this.journal.append(
      workflowInstanceStream(workflowInstanceId(id)),
      sequence,
      drafts,
    );
    return events.map(decodeOrchestrationEvent).filter(isWorkflowEvent);
  }

  async list(): Promise<readonly ListedInstance[]> {
    return this.listed.get();
  }
}

function isWorkflowEvent(
  event: ReturnType<typeof decodeOrchestrationEvent>,
): event is WorkflowOrchestrationEvent {
  return isWorkflowInstanceStream(event.stream);
}

// `sequence` counts every event on the stream, matching readStream, while the
// fold sees only owned orchestration events — exactly what load() computes.
function deriveList(events: readonly JournalEvent[]): readonly ListedInstance[] {
  const streams = new Map<string, JournalEvent[]>();
  for (const event of events) {
    if (!isWorkflowInstanceStream(event.stream)) continue;
    const existing = streams.get(event.stream.id);
    if (existing === undefined) streams.set(event.stream.id, [event]);
    else existing.push(event);
  }
  return [...streams.values()].map((streamEvents) => ({
    sequence: streamEvents.length,
    view: foldWorkflowInstance(
      streamEvents
        .map(selectWorkflowOrchestrationEvent)
        .filter(
          (event): event is WorkflowOrchestrationEvent =>
            event !== null && isWorkflowInstanceStream(event.stream),
        ),
    ),
  }));
}
