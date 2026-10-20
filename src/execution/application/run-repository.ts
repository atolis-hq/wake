import {
  decodeOnce,
  foldedJournalView,
  type EventJournal,
  type JournalView,
} from '@atolis-hq/eventing';
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

const decodeRun = decodeOnce(decodeRunExecutionEvent);

export class RunRepository {
  private readonly runs: JournalView<RunsState>;

  constructor(private readonly journal: EventJournal) {
    this.runs = foldedJournalView(journal, { initial: emptyRuns, extend: extendRuns });
  }

  async load(runId: RunId): Promise<{
    readonly sequence: number;
    readonly events?: readonly RunExecutionEvent[];
    readonly view: ReturnType<typeof foldRun>;
  }> {
    const events = await this.journal.readStream(runStream(runId));
    const decoded = events.map(decodeRun);
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
    const { views: runs } = await this.runs.get();
    return activationId === undefined
      ? runs
      : runs.filter((run) => run.activationId === activationId);
  }
}

interface RunsState {
  readonly events: ReadonlyMap<RunId, readonly RunExecutionEvent[]>;
  readonly byRun: ReadonlyMap<RunId, RunView | null>;
  readonly views: readonly RunView[];
}

const emptyRuns: RunsState = { events: new Map(), byRun: new Map(), views: [] };

// Decodes and folds only the runs the new events touch; untouched runs keep
// their decoded history and view, so a journal move costs the delta.
function extendRuns(state: RunsState, events: readonly JournalEvent[]): RunsState {
  const touched = new Map<RunId, RunExecutionEvent[]>();
  for (const event of events) {
    if (!isRunStream(event.stream)) continue;
    const id = runId(event.stream.id);
    const batch = touched.get(id) ?? [];
    batch.push(decodeRun(event));
    touched.set(id, batch);
  }
  if (touched.size === 0) return state;
  const history = new Map(state.events);
  const byRun = new Map(state.byRun);
  for (const [id, batch] of touched) {
    const all = [...(history.get(id) ?? []), ...batch];
    history.set(id, all);
    byRun.set(id, foldRun(all));
  }
  return {
    events: history,
    byRun,
    views: [...byRun.values()].filter((run) => run !== null),
  };
}
