import { ActivityRegistry } from '../activities/index.js';
import { createAdvanceOnce } from '../control-plane/index.js';
import { createExecutionService } from '../execution/index.js';
import {
  SystemClock,
  UlidIdGenerator,
  type CheckpointStore,
  type EventJournal,
  type ProjectionStore,
} from '../kernel/index.js';
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProjectionStore,
} from '../persistence/index.js';
import { compileWorkflow, createOrchestrationService } from '../orchestration/index.js';
import { createResourceService } from '../resources/index.js';
import { createWorkService } from '../work/index.js';
import { loadConfig, type ResolvedWakeModulesConfig } from './config/load-config.js';
import { resolveWakePaths, type WakePaths } from './paths.js';
import { createRuntimeProjectionRunner } from './projection-runtime.js';

export interface CompositionRootOptions {
  readonly config?: ResolvedWakeModulesConfig;
  readonly journal?: EventJournal;
  readonly projections?: ProjectionStore;
  readonly checkpoints?: CheckpointStore;
  readonly activities?: ActivityRegistry;
}

export interface CompositionRoot {
  readonly config: ResolvedWakeModulesConfig;
  readonly paths: WakePaths;
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
  readonly activities: ActivityRegistry;
  readonly work: ReturnType<typeof createWorkService>;
  readonly resources: ReturnType<typeof createResourceService>;
  readonly orchestration: ReturnType<typeof createOrchestrationService>;
  readonly execution: ReturnType<typeof createExecutionService>;
  readonly advanceOnce: ReturnType<typeof createAdvanceOnce>;
  readonly projectionRunner: ReturnType<typeof createRuntimeProjectionRunner>;
}

export async function createCompositionRoot(
  wakeRoot: string,
  options: CompositionRootOptions = {},
): Promise<CompositionRoot> {
  const config = options.config ?? (await loadConfig(wakeRoot));
  const paths = resolveWakePaths(wakeRoot);
  const clock = new SystemClock();
  const ids = new UlidIdGenerator();
  const journal = options.journal ?? new FileEventJournal(paths.dataRoot, clock);
  const projections = options.projections ?? new FileProjectionStore(paths.dataRoot);
  const checkpoints = options.checkpoints ?? new FileCheckpointStore(paths.dataRoot);
  const activities = options.activities ?? new ActivityRegistry();
  const work = createWorkService(journal);
  const resources = createResourceService(journal);
  const definitions = Object.fromEntries(
    Object.entries(config.orchestration.workflows).map(([name, definition]) => [
      name,
      compileWorkflow(name, definition, activities, Object.keys(config.orchestration.workflows)),
    ]),
  );
  const orchestration = createOrchestrationService(journal, work, definitions);
  const execution = createExecutionService(journal, activities, config.execution, { clock, ids });
  const advanceOnce = createAdvanceOnce(orchestration, execution, resources, clock, ids);
  return {
    config,
    paths,
    journal,
    projections,
    checkpoints,
    activities,
    work,
    resources,
    orchestration,
    execution,
    advanceOnce,
    projectionRunner: createRuntimeProjectionRunner(journal, projections, checkpoints),
  };
}
