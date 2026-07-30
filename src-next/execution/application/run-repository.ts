import { entityRef, type EventDraft, type EventJournal } from '../../kernel/index.js';
import { foldRun } from '../domain/run.js';
export class RunRepository {
  constructor(private readonly journal: EventJournal) {}
  async load(runId: string) {
    const events = await this.journal.readStream(entityRef('run', runId));
    return { sequence: events.length, view: foldRun(events) };
  }
  append(runId: string, sequence: number, events: readonly EventDraft[]) {
    return this.journal.append(entityRef('run', runId), sequence, events);
  }
  async list(activationId?: string) {
    const ids = new Set(
      (await this.journal.readAll(0))
        .filter((event) => event.stream.kind === 'run')
        .map((event) => event.stream.id),
    );
    const runs = (await Promise.all([...ids].map(async (id) => (await this.load(id)).view))).filter(
      (run) => run !== null,
    );
    return activationId === undefined
      ? runs
      : runs.filter((run) => run.activationId === activationId);
  }
}
