import type { ActivationId } from '../../activities/index.js';
import type { EventJournal } from '../../kernel/index.js';
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
  async load(runId: RunId): Promise<{
    readonly sequence: number;
    readonly events?: readonly RunExecutionEvent[];
    readonly view: ReturnType<typeof foldRun>;
  }> {
    const events = await this.journal.readStream(runStream(runId));
    const decoded = events.map(decodeRunExecutionEvent);
    return { sequence: events.length, events: decoded, view: foldRun(decoded) };
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
    const grouped = new Map<RunId, RunExecutionEvent[]>();
    for (const event of await this.journal.readAll(0)) {
      if (!isRunStream(event.stream)) continue;
      const id = runId(event.stream.id);
      const events = grouped.get(id) ?? [];
      events.push(decodeRunExecutionEvent(event));
      grouped.set(id, events);
    }
    const runs = (await Promise.all([...grouped.values()].map(foldRun))).filter(
      (run) => run !== null,
    );
    return activationId === undefined
      ? runs
      : runs.filter((run) => run.activationId === activationId);
  }
}
