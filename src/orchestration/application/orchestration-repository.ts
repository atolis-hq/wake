import type { EventJournal } from '../../kernel/index.js';
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
import { foldWorkflowInstance } from '../domain/workflow-instance.js';

export class OrchestrationRepository {
  constructor(private readonly journal: EventJournal) {}
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

  async list() {
    const events = await this.journal.readAll(0);
    const streams = new Map<string, (typeof events)[number][]>();
    for (const event of events) {
      if (!isWorkflowInstanceStream(event.stream)) continue;
      const existing = streams.get(event.stream.id);
      if (existing === undefined) streams.set(event.stream.id, [event]);
      else existing.push(event);
    }
    // `sequence` counts every event on the stream, matching readStream, while the
    // fold sees only owned orchestration events — exactly what load() computes.
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
}

function isWorkflowEvent(
  event: ReturnType<typeof decodeOrchestrationEvent>,
): event is WorkflowOrchestrationEvent {
  return isWorkflowInstanceStream(event.stream);
}
