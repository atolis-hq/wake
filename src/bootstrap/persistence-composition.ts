import type { CheckpointStore, Clock, EventJournal, ProjectionStore } from '../kernel/index.js';
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProjectionStore,
} from '../persistence/index.js';
import type { WakePaths } from './paths.js';
import {
  createResourceTransitionOrdering,
  createTriggerAwareEventJournal,
  createTriggerRegistry,
} from './resource-transition-ordering.js';

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
  readonly resourceTransitionOrdering: ReturnType<typeof createResourceTransitionOrdering>;
  readonly resourceTransitionTriggers: ReturnType<typeof createTriggerRegistry>;
}

function identity<T>(value: T): T {
  return value;
}

export function composePersistence(
  paths: WakePaths,
  clock: Clock,
  options: PersistenceCompositionOptions,
): PersistenceComposition {
  const resourceTransitionOrdering = createResourceTransitionOrdering(
    options.journal === undefined
      ? `${paths.locksRoot}/resource-transition-ordering.lock`
      : undefined,
  );
  const resourceTransitionTriggers = createTriggerRegistry();
  const journal = createTriggerAwareEventJournal(
    (options.decorateJournal ?? identity)(
      options.journal ?? new FileEventJournal(paths.dataRoot, clock),
    ),
    resourceTransitionTriggers,
    resourceTransitionOrdering,
  );
  return {
    journal,
    projections: (options.decorateProjections ?? identity)(
      options.projections ?? new FileProjectionStore(paths.dataRoot),
    ),
    checkpoints: (options.decorateCheckpoints ?? identity)(
      options.checkpoints ?? new FileCheckpointStore(paths.dataRoot),
    ),
    resourceTransitionOrdering,
    resourceTransitionTriggers,
  };
}
