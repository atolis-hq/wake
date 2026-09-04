import type {
  CheckpointStore,
  EventJournal,
  ProjectionDefinition,
  ProjectionStore,
} from '@atolis-hq/eventing';
import {
  ProjectionRebuilder,
  createProjectionProcessor,
  type EventProcessor,
  type EventProcessorHealth,
  type EventProcessorHostRun,
  type ProcessorRunSerialiser,
} from '@atolis-hq/eventing';
import { createInMemoryProcessorRunSerialiser } from '@atolis-hq/eventing/memory';
import { activityProjectionDefinitions } from '../activities/index.js';
import { controlPlaneProjectionDefinitions } from '../control-plane/index.js';
import { conversationProjection } from '../conversations/index.js';
import { executionProjection, runsByWorkflowInstanceProjection } from '../execution/index.js';
import { deliveryProjectionDefinitions, type DeliveryIntentView } from '../integrations/index.js';
import {
  orchestrationProjection,
  workflowDefinitionsProjection,
  workflowsByWorkItemProjection,
} from '../orchestration/index.js';
import {
  resourceCorrelationProjection,
  resourceProjection,
  resourcesByExternalKeyProjection,
  workCorrelationsProjection,
} from '../resources/index.js';
import { workProjection } from '../work/index.js';
import { analyticsProjection } from './analytics-projection.js';
import { boardProjection } from './board-projection.js';
import type { EventProcessorRuntime } from './event-processor-runtime.js';

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

export interface RuntimeProjectionSubscriptions {
  /** Named Eventing processor definitions, one for every runtime projection. */
  readonly processors: readonly EventProcessor[];
  start(signal: AbortSignal): EventProcessorHostRun;
  catchUpOnce(signal?: AbortSignal): Promise<number>;
  catchUp(definition: ProjectionDefinition, signal?: AbortSignal): Promise<number>;
  rebuild(definition: ProjectionDefinition, signal?: AbortSignal): Promise<number>;
  health(): Promise<readonly EventProcessorHealth[]>;
}

class RuntimeProjectionSubscriptionRuntime implements RuntimeProjectionSubscriptions {
  readonly processors: readonly EventProcessor[];
  private readonly processorsByDefinition = new Map<string, EventProcessor>();
  private readonly definitionsByName = new Map<string, ProjectionDefinition>();
  private readonly rebuilder: ProjectionRebuilder;

  constructor(
    private readonly journal: EventJournal,
    projections: ProjectionStore,
    checkpoints: CheckpointStore,
    serialiseRun: ProcessorRunSerialiser,
    private readonly runtime: EventProcessorRuntime,
    definitions: readonly ProjectionDefinition[],
  ) {
    this.processors = definitions.map((definition) => {
      const processor = createProjectionProcessor(definition, projections);
      if (this.processorsByDefinition.has(definition.name))
        throw new Error(`Runtime projection definition is already registered: ${definition.name}`);
      this.processorsByDefinition.set(definition.name, processor);
      this.definitionsByName.set(definition.name, definition);
      return processor;
    });
    this.rebuilder = new ProjectionRebuilder(journal, projections, checkpoints, serialiseRun);
  }

  start(signal: AbortSignal): EventProcessorHostRun {
    return this.runtime.start(signal);
  }

  async catchUpOnce(signal?: AbortSignal): Promise<number> {
    return this.runtime.catchUp('projection catch-up', this.processors, signal);
  }

  async catchUp(definition: ProjectionDefinition, signal?: AbortSignal): Promise<number> {
    const processor = this.processorsByDefinition.get(definition.name);
    if (processor === undefined)
      throw new Error(`Runtime projection definition is not registered: ${definition.name}`);
    return this.runtime.catchUp(`projection:${definition.name}`, [processor], signal);
  }

  rebuild(definition: ProjectionDefinition, signal?: AbortSignal): Promise<number> {
    return this.rebuilder.rebuild(this.registeredDefinition(definition), signal);
  }

  async health(): Promise<readonly EventProcessorHealth[]> {
    const health = await this.runtime.health();
    const consumers = new Set(this.processors.map((processor) => processor.consumer));
    return health.filter(({ consumer }) => consumers.has(consumer));
  }

  private registeredDefinition(definition: ProjectionDefinition): ProjectionDefinition {
    const registered = this.definitionsByName.get(definition.name);
    if (registered === undefined)
      throw new Error(`Runtime projection definition is not registered: ${definition.name}`);
    return registered;
  }
}

export function createRuntimeProjectionSubscriptions(
  journal: EventJournal,
  projections: ProjectionStore,
  checkpoints: CheckpointStore,
  runtime: EventProcessorRuntime,
  serialiseRun: ProcessorRunSerialiser = createInMemoryProcessorRunSerialiser(),
  definitions: readonly ProjectionDefinition[] = runtimeProjectionDefinitions,
): RuntimeProjectionSubscriptions {
  return new RuntimeProjectionSubscriptionRuntime(
    journal,
    projections,
    checkpoints,
    serialiseRun,
    runtime,
    definitions,
  );
}

export type { DeliveryIntentView };
