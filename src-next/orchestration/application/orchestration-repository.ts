import type { EventDraft, EventJournal } from '../../kernel/index.js';
import { workflowInstanceId } from '../contracts/identifiers.js';
import { isWorkflowInstanceStream, workflowInstanceStream } from '../contracts/streams.js';
import { foldWorkflowInstance } from '../domain/workflow-instance.js';
export class OrchestrationRepository {
  constructor(private readonly journal: EventJournal) {}
  async load(id: string) {
    const events = await this.journal.readStream(workflowInstanceStream(workflowInstanceId(id)));
    return { sequence: events.length, view: foldWorkflowInstance(events) };
  }
  append(id: string, sequence: number, events: readonly EventDraft[]) {
    return this.journal.append(workflowInstanceStream(workflowInstanceId(id)), sequence, events);
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
