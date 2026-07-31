import type { EventJournal } from '../../kernel/index.js';
import {
  decodeOrchestrationEvent,
  selectWorkflowOrchestrationEvent,
  type WorkflowOrchestrationEvent,
  type WorkflowOrchestrationEventDraft,
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
    const ids = new Set(
      (await this.journal.readAll(0))
        .filter((event) => isWorkflowInstanceStream(event.stream))
        .map((event) => event.stream.id),
    );
    return Promise.all([...ids].map(async (id) => (await this.load(id)).view));
  }
}

function isWorkflowEvent(
  event: ReturnType<typeof decodeOrchestrationEvent>,
): event is WorkflowOrchestrationEvent {
  return isWorkflowInstanceStream(event.stream);
}
