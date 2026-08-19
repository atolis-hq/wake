import type { CheckpointStore, Clock, EventJournal, ProjectionStore } from '../kernel/index.js';
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProjectionStore,
} from '../persistence/index.js';
import type { WakePaths } from './paths.js';

export interface PersistenceCompositionOptions {
  readonly journal?: EventJournal;
  readonly projections?: ProjectionStore;
  readonly checkpoints?: CheckpointStore;
  readonly decorateJournal?: (journal: EventJournal) => EventJournal;
  readonly decorateProjections?: (projections: ProjectionStore) => ProjectionStore;
  readonly decorateCheckpoints?: (checkpoints: CheckpointStore) => CheckpointStore;
}

export interface PersistenceComposition {
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
}

function identity<T>(value: T): T {
  return value;
}

function serializeJournalAppends(journal: EventJournal): EventJournal {
  let appendTail: Promise<void> = Promise.resolve();
  return {
    append(stream, expectedSequence, events) {
      const appended = appendTail.then(() => journal.append(stream, expectedSequence, events));
      appendTail = appended.then(
        () => undefined,
        () => undefined,
      );
      return appended;
    },
    readStream: (stream) => journal.readStream(stream),
    readAll: (afterGlobalPosition, limit) => journal.readAll(afterGlobalPosition, limit),
    latestGlobalPosition: () => journal.latestGlobalPosition(),
    changeSignal: journal.changeSignal,
    ...(journal.readLatest === undefined
      ? {}
      : {
          readLatest: (beforeGlobalPosition, limit) =>
            journal.readLatest!(beforeGlobalPosition, limit),
        }),
  };
}

export function composePersistence(
  paths: WakePaths,
  clock: Clock,
  options: PersistenceCompositionOptions,
): PersistenceComposition {
  return {
    journal: serializeJournalAppends(
      (options.decorateJournal ?? identity)(
        options.journal ?? new FileEventJournal(paths.dataRoot, clock),
      ),
    ),
    projections: (options.decorateProjections ?? identity)(
      options.projections ?? new FileProjectionStore(paths.dataRoot),
    ),
    checkpoints: (options.decorateCheckpoints ?? identity)(
      options.checkpoints ?? new FileCheckpointStore(paths.dataRoot),
    ),
  };
}
