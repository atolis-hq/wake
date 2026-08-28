import { join } from 'node:path';
import { activityProjectionDefinitions } from '../activities/index.js';
import { controlPlaneProjectionDefinitions } from '../control-plane/index.js';
import { conversationProjection } from '../conversations/index.js';
import { executionProjection, runsByWorkflowInstanceProjection } from '../execution/index.js';
import { deliveryProjectionDefinitions, type DeliveryIntentView } from '../integrations/index.js';
import type { CheckpointStore, EventJournal, ProjectionStore } from '../kernel/index.js';
import {
  orchestrationProjection,
  workflowDefinitionsProjection,
  workflowsByWorkItemProjection,
} from '../orchestration/index.js';
import {
  acquireFileLock,
  ProjectionRunner,
  type ProjectionRunSerialiser,
} from '../persistence/index.js';
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
  conversationProjection,
  workProjection,
  resourceProjection,
  resourceCorrelationProjection,
  resourcesByExternalKeyProjection,
  workCorrelationsProjection,
  ...activityProjectionDefinitions,
  ...deliveryProjectionDefinitions,
  ...controlPlaneProjectionDefinitions,
  orchestrationProjection,
  workflowsByWorkItemProjection,
  workflowDefinitionsProjection,
  executionProjection,
  runsByWorkflowInstanceProjection,
  boardProjection,
  analyticsProjection,
];

export function createRuntimeProjectionRunner(
  journal: EventJournal,
  projections: ProjectionStore,
  checkpoints: CheckpointStore,
  serialiseRun?: ProjectionRunSerialiser,
): ProjectionRunner {
  return new ProjectionRunner(
    journal,
    projections,
    checkpoints,
    runtimeProjectionDefinitions,
    serialiseRun,
  );
}

export function createFileProjectionRunSerialiser(dataRoot: string): ProjectionRunSerialiser {
  const path = join(dataRoot, 'locks', 'projection-runner.lock');
  return async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    while (true) {
      const lock = await acquireFileLock(path, {
        staleAfterMs: 60_000,
        staleRequiresDeadProcess: true,
      });
      if (lock.acquired) {
        try {
          return await operation();
        } finally {
          await lock.release();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
}

export type { DeliveryIntentView };
