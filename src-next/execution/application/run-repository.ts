import type { EventJournal } from '../../kernel/index.js';
import type { ActivationId } from '../../activities/index.js';
import {
  decodeRunExecutionEvent,
  type RunExecutionEvent,
  type RunExecutionEventDraft,
} from '../contracts/events.js';
import { runId, type RunId } from '../contracts/identifiers.js';
import { isRunStream, runStream } from '../contracts/streams.js';
import { foldRun } from '../domain/run.js';
export class RunRepository {
  constructor(private readonly journal: EventJournal) {}
  async load(runId: RunId) {
    const events = await this.journal.readStream(runStream(runId));
    return { sequence: events.length, view: foldRun(events.map(decodeRunExecutionEvent)) };
  }
  async append(
    runId: RunId,
    sequence: number,
    drafts: readonly RunExecutionEventDraft[],
  ): Promise<readonly RunExecutionEvent[]> {
    const events = await this.journal.append(runStream(runId), sequence, drafts);
    return events.map(decodeRunExecutionEvent);
  }
  async list(activationId?: ActivationId) {
    const ids = new Set(
      (await this.journal.readAll(0))
        .filter((event) => isRunStream(event.stream))
        .map((event) => runId(event.stream.id)),
    );
    const runs = (await Promise.all([...ids].map(async (id) => (await this.load(id)).view))).filter(
      (run) => run !== null,
    );
    return activationId === undefined
      ? runs
      : runs.filter((run) => run.activationId === activationId);
  }
}
