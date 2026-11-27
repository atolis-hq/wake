import {
  registerViewSnapshotStore,
  type CheckpointStore,
  type EventJournal,
  type ProcessorRunSerialiser,
  type ProcessorStateStore,
  type ProjectionStore,
  type ViewSnapshotStore,
} from '@atolis-hq/eventing';
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProcessorStateStore,
  FileProjectionStore,
  FileViewSnapshotStore,
  createFileProcessorRunSerialiser,
} from '@atolis-hq/eventing-filesystem';
import type { Clock } from '../kernel/index.js';
import type { WakePaths } from './paths.js';

export interface PersistenceCompositionOptions {
  readonly readOnlyJournal?: boolean;
  readonly journal?: EventJournal;
  readonly projections?: ProjectionStore;
  readonly checkpoints?: CheckpointStore;
  readonly processorState?: ProcessorStateStore;
  readonly viewSnapshots?: ViewSnapshotStore;
  readonly decorateJournal?: (journal: EventJournal) => EventJournal;
  readonly decorateProjections?: (projections: ProjectionStore) => ProjectionStore;
  readonly decorateCheckpoints?: (checkpoints: CheckpointStore) => CheckpointStore;
  readonly subscriptionRunSerialiser?: ProcessorRunSerialiser;
}

export interface PersistenceComposition {
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
  readonly processorState: ProcessorStateStore;
  readonly subscriptionRunSerialiser: ProcessorRunSerialiser;
}

function identity<T>(value: T): T {
  return value;
}

function serializeJournalAppends(journal: EventJournal): EventJournal {
  let appendTail: Promise<void> = Promise.resolve();
  return {
    appendToStream(stream, expectedSequence, events) {
      const appended = appendTail.then(() =>
        journal.appendToStream(stream, expectedSequence, events),
      );
      appendTail = appended.then(
        () => undefined,
        () => undefined,
      );
      return appended;
    },
    readStream: (stream) => journal.readStream(stream),
    ...(journal.scanAll === undefined
      ? {}
      : { scanAll: (signal?: AbortSignal) => journal.scanAll!(signal) }),
    readAll: (afterGlobalPosition, limit) => journal.readAll(afterGlobalPosition, limit),
    latestGlobalPosition: () => journal.latestGlobalPosition(),
    waitForEventsAfter: (afterGlobalPosition, signal, fallbackMs) =>
      journal.waitForEventsAfter(afterGlobalPosition, signal, fallbackMs),
    changeSignal: journal.changeSignal,
    ...(journal.readLatestMatching === undefined
      ? {}
      : {
          readLatestMatching: (filter, before, limit) =>
            journal.readLatestMatching!(filter, before, limit),
        }),
    ...(journal.readLatest === undefined
      ? {}
      : {
          readLatest: (beforeGlobalPosition, limit) =>
            journal.readLatest!(beforeGlobalPosition, limit),
        }),
  };
}

// An injected journal is a test double with no relation to files on disk.
function viewSnapshotStore(
  paths: WakePaths,
  options: PersistenceCompositionOptions,
): ViewSnapshotStore | undefined {
  if (options.viewSnapshots !== undefined) return options.viewSnapshots;
  return options.journal === undefined
    ? new FileViewSnapshotStore(paths.viewSnapshotsRoot)
    : undefined;
}

export function composePersistence(
  paths: WakePaths,
  clock: Clock,
  options: PersistenceCompositionOptions,
): PersistenceComposition {
  const subscriptionRunSerialiser =
    options.subscriptionRunSerialiser ?? createFileProcessorRunSerialiser(paths.dataRoot);
  const journal = serializeJournalAppends(
    (options.decorateJournal ?? identity)(
      options.journal ??
        new FileEventJournal(paths.dataRoot, clock, {
          readOnly: options.readOnlyJournal ?? false,
        }),
    ),
  );
  const viewSnapshots = viewSnapshotStore(paths, options);
  if (viewSnapshots !== undefined) registerViewSnapshotStore(journal, viewSnapshots);
  return {
    journal,
    projections: (options.decorateProjections ?? identity)(
      options.projections ?? new FileProjectionStore(paths.dataRoot),
    ),
    checkpoints: (options.decorateCheckpoints ?? identity)(
      options.checkpoints ?? new FileCheckpointStore(paths.dataRoot),
    ),
    processorState: options.processorState ?? new FileProcessorStateStore(paths.dataRoot),
    subscriptionRunSerialiser,
  };
}
