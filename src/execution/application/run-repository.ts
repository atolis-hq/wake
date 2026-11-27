import {
  decodeOnce,
  foldedJournalView,
  type EventJournal,
  type JournalView,
  type ViewSnapshotCodec,
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
import { foldRun, foldRunEvent } from '../domain/run.js';

type JournalEvent = Awaited<ReturnType<EventJournal['readAll']>>[number];

const decodeRun = decodeOnce(decodeRunExecutionEvent);

export class RunRepository {
  private readonly runs: JournalView<RunsState>;

  constructor(private readonly journal: EventJournal) {
    this.runs = foldedJournalView(journal, {
      name: 'run-views',
      initial: emptyRuns,
      extend: extendRuns,
      persist: { schemaVersion: 1, codec: runsCodec },
    });
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
  readonly byRun: ReadonlyMap<RunId, RunView>;
  readonly views: readonly RunView[];
}

const emptyRuns: RunsState = { byRun: new Map(), views: [] };

// Bump `schemaVersion` when RunView or its fold changes shape: a snapshot is
// trusted for its version, not re-validated field by field.
const runsCodec: ViewSnapshotCodec<RunsState> = {
  encode: (state) => [...state.byRun.values()],
  decode(raw) {
    if (!Array.isArray(raw)) throw new Error('Run snapshot must be an array');
    const byRun = new Map<RunId, RunView>();
    for (const view of raw as RunView[]) {
      if (typeof view?.runId !== 'string') throw new Error('Run snapshot entry has no runId');
      byRun.set(view.runId, view);
    }
    return { byRun, views: [...byRun.values()] };
  },
};

// Folds only the events the journal moved by, one run view at a time; untouched
// runs keep their view, so a journal move costs the delta.
function extendRuns(state: RunsState, events: readonly JournalEvent[]): RunsState {
  let byRun: Map<RunId, RunView> | undefined;
  for (const event of events) {
    if (!isRunStream(event.stream)) continue;
    const id = runId(event.stream.id);
    byRun ??= new Map(state.byRun);
    byRun.set(id, foldRunEvent(byRun.get(id) ?? null, decodeRun(event)));
  }
  return byRun === undefined ? state : { byRun, views: [...byRun.values()] };
}
