import { activityProjectionDefinitions } from '../activities/index.js';
import type { CheckpointStore, EventJournal, ProjectionStore } from '../kernel/index.js';
import { ProjectionRunner } from '../persistence/index.js';
import { resourceCorrelationProjection, resourceProjection } from '../resources/index.js';
import { workProjection } from '../work/index.js';

export const runtimeProjectionDefinitions = [
  workProjection,
  resourceProjection,
  resourceCorrelationProjection,
  ...activityProjectionDefinitions,
];

export function createRuntimeProjectionRunner(
  journal: EventJournal,
  projections: ProjectionStore,
  checkpoints: CheckpointStore,
): ProjectionRunner {
  return new ProjectionRunner(journal, projections, checkpoints, runtimeProjectionDefinitions);
}
