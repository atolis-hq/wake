import type {
  CheckpointStore,
  EventJournal,
  ProcessorRunSerialiser,
  ProcessorStateStore,
  ProjectionStore,
} from '@atolis-hq/eventing';
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProcessorStateStore,
  FileProjectionStore,
  createFileProcessorRunSerialiser,
} from '@atolis-hq/eventing-filesystem';
import type { Clock } from '../kernel/index.js';
import type { WakePaths } from './paths.js';

export interface PersistenceCompositionOptions {
  readonly journal?: EventJournal;
  readonly projections?: ProjectionStore;
  readonly checkpoints?: CheckpointStore;
  readonly processorState?: ProcessorStateStore;
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
    readAll: (afterGlobalPosition, limit) => journal.readAll(afterGlobalPosition, limit),
    latestGlobalPosition: () => journal.latestGlobalPosition(),
    waitForEventsAfter: (afterGlobalPosition, signal, fallbackMs) =>
      journal.waitForEventsAfter(afterGlobalPosition, signal, fallbackMs),
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
  const subscriptionRunSerialiser =
    options.subscriptionRunSerialiser ?? createFileProcessorRunSerialiser(paths.dataRoot);
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
    processorState: options.processorState ?? new FileProcessorStateStore(paths.dataRoot),
    subscriptionRunSerialiser,
  };
}
