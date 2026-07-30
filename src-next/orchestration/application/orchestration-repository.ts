import { entityRef, type EventDraft, type EventJournal } from '../../kernel/index.js';
import { foldWorkflowInstance } from '../domain/workflow-instance.js';
export class OrchestrationRepository {
  constructor(private readonly journal: EventJournal) {}
  async load(id: string) {
    const events = await this.journal.readStream(entityRef('workflow-instance', id));
    return { sequence: events.length, view: foldWorkflowInstance(events) };
  }
  append(id: string, sequence: number, events: readonly EventDraft[]) {
    return this.journal.append(entityRef('workflow-instance', id), sequence, events);
  }
  async list() {
    const ids = new Set(
      (await this.journal.readAll(0))
        .filter((event) => event.stream.kind === 'workflow-instance')
        .map((event) => event.stream.id),
    );
    return Promise.all([...ids].map(async (id) => (await this.load(id)).view));
  }
}
