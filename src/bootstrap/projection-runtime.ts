import { activityProjectionDefinitions } from '../activities/index.js';
import { controlPlaneProjectionDefinitions } from '../control-plane/index.js';
import { executionProjection } from '../execution/index.js';
import { deliveryProjectionDefinitions, type DeliveryIntentView } from '../integrations/index.js';
import type { CheckpointStore, EventJournal, ProjectionStore } from '../kernel/index.js';
import { orchestrationProjection, workflowDefinitionsProjection } from '../orchestration/index.js';
import { ProjectionRunner } from '../persistence/index.js';
import {
  resourceCorrelationProjection,
  resourceProjection,
  resourcesByExternalKeyProjection,
  workCorrelationsProjection,
} from '../resources/index.js';
import { workProjection } from '../work/index.js';
import { analyticsProjection } from './analytics-projection.js';
import { boardProjection } from './board-projection.js';

export const runtimeProjectionDefinitions = [
  workProjection,
  resourceProjection,
  resourceCorrelationProjection,
  resourcesByExternalKeyProjection,
  workCorrelationsProjection,
  ...activityProjectionDefinitions,
  ...deliveryProjectionDefinitions,
  ...controlPlaneProjectionDefinitions,
  orchestrationProjection,
  workflowDefinitionsProjection,
  executionProjection,
  boardProjection,
  analyticsProjection,
];

export function createRuntimeProjectionRunner(
  journal: EventJournal,
  projections: ProjectionStore,
  checkpoints: CheckpointStore,
): ProjectionRunner {
  return new ProjectionRunner(journal, projections, checkpoints, runtimeProjectionDefinitions);
}

export type { DeliveryIntentView };
