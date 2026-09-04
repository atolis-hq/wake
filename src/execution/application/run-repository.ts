import { cachedJournalView, type CachedJournalView, type EventJournal } from '@atolis-hq/eventing';
import type { ActivationId } from '../../activities/index.js';
import {
  decodeRunExecutionEvent,
  type RunExecutionEvent,
  type RunExecutionEventData,
} from '../contracts/events.js';
import { runId, type RunId } from '../contracts/identifiers.js';
import { isRunStream, runStream } from '../contracts/streams.js';
import type { RunView } from '../contracts/views.js';
import { foldRun } from '../domain/run.js';

type JournalEvent = Awaited<ReturnType<EventJournal['readAll']>>[number];

export class RunRepository {
  private readonly runs: CachedJournalView<readonly RunView[]>;

  constructor(private readonly journal: EventJournal) {
    this.runs = cachedJournalView(journal, deriveRuns);
  }

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
    drafts: readonly RunExecutionEventData[],
  ): Promise<readonly RunExecutionEvent[]> {
    const events = await this.journal.appendToStream(runStream(runId), sequence, drafts);
    return events.map(decodeRunExecutionEvent);
  }

  async list(activationId?: ActivationId): Promise<readonly RunView[]> {
    const runs = await this.runs.get();
    return activationId === undefined
      ? runs
      : runs.filter((run) => run.activationId === activationId);
  }
}

function deriveRuns(events: readonly JournalEvent[]): readonly RunView[] {
  const grouped = new Map<RunId, RunExecutionEvent[]>();
  for (const event of events) {
    if (!isRunStream(event.stream)) continue;
    const id = runId(event.stream.id);
    const decoded = grouped.get(id) ?? [];
    decoded.push(decodeRunExecutionEvent(event));
    grouped.set(id, decoded);
  }
  return [...grouped.values()].map(foldRun).filter((run) => run !== null);
}
