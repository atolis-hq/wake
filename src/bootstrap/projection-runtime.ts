import { activityProjectionDefinitions } from '../activities/index.js';
import { controlPlaneProjectionDefinitions } from '../control-plane/index.js';
import { conversationProjection } from '../conversations/index.js';
import {
  EventProcessorHost,
  ProjectionRebuilder,
  createProjectionProcessor,
  type EventProcessor,
  type EventProcessorHealth,
  type EventProcessorHostRun,
  type ProcessorRunSerialiser,
} from '../eventing/index.js';
import { executionProjection, runsByWorkflowInstanceProjection } from '../execution/index.js';
import { deliveryProjectionDefinitions, type DeliveryIntentView } from '../integrations/index.js';
import type {
  CheckpointStore,
  EventJournal,
  ProjectionDefinition,
  ProjectionStore,
} from '../kernel/index.js';
import {
  orchestrationProjection,
  workflowDefinitionsProjection,
  workflowsByWorkItemProjection,
} from '../orchestration/index.js';
import { createInMemoryProcessorRunSerialiser } from '../persistence/index.js';
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

export interface RuntimeProjectionSubscriptions {
  /** Named Eventing processor definitions, one for every runtime projection. */
  readonly processors: readonly EventProcessor[];
  start(signal: AbortSignal): EventProcessorHostRun;
  catchUpOnce(signal?: AbortSignal): Promise<number>;
  catchUp(definition: ProjectionDefinition, signal?: AbortSignal): Promise<number>;
  rebuild(definition: ProjectionDefinition, signal?: AbortSignal): Promise<number>;
  health(): readonly EventProcessorHealth[];
}

class RuntimeProjectionSubscriptionRuntime implements RuntimeProjectionSubscriptions {
  readonly processors: readonly EventProcessor[];
  private readonly processorsByDefinition = new Map<string, EventProcessor>();
  private readonly definitionsByName = new Map<string, ProjectionDefinition>();
  private readonly host: EventProcessorHost;
  private readonly rebuilder: ProjectionRebuilder;

  constructor(
    private readonly journal: EventJournal,
    projections: ProjectionStore,
    private readonly checkpoints: CheckpointStore,
    serialiseRun: ProcessorRunSerialiser,
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
    this.host = new EventProcessorHost(journal, checkpoints, serialiseRun);
    this.rebuilder = new ProjectionRebuilder(journal, projections, checkpoints, serialiseRun);
  }

  start(signal: AbortSignal): EventProcessorHostRun {
    return this.host.start(this.processors, signal);
  }

  async catchUpOnce(signal?: AbortSignal): Promise<number> {
    const targetGlobalPosition = await this.journal.latestGlobalPosition();
    const pendingProcessors = (
      await Promise.all(
        this.processors.map(async (processor) => ({
          processor,
          checkpoint: await this.checkpoints.load(processor.consumer),
        })),
      )
    ).filter(({ checkpoint }) => checkpoint < targetGlobalPosition);
    const passes = await Promise.all(
      pendingProcessors.map(({ processor }) =>
        this.host.runThrough(processor, targetGlobalPosition, signal),
      ),
    );
    return passes.reduce((eventCount, pass) => eventCount + pass.eventCount, 0);
  }

  async catchUp(definition: ProjectionDefinition, signal?: AbortSignal): Promise<number> {
    const processor = this.processorsByDefinition.get(definition.name);
    if (processor === undefined)
      throw new Error(`Runtime projection definition is not registered: ${definition.name}`);
    return (await this.host.runOnce(processor, signal)).eventCount;
  }

  rebuild(definition: ProjectionDefinition, signal?: AbortSignal): Promise<number> {
    return this.rebuilder.rebuild(this.registeredDefinition(definition), signal);
  }

  health(): readonly EventProcessorHealth[] {
    return this.processors.flatMap((processor) => {
      const snapshot = this.host.health(processor.consumer);
      return snapshot === undefined ? [] : [snapshot];
    });
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
  serialiseRun: ProcessorRunSerialiser = createInMemoryProcessorRunSerialiser(),
  definitions: readonly ProjectionDefinition[] = runtimeProjectionDefinitions,
): RuntimeProjectionSubscriptions {
  return new RuntimeProjectionSubscriptionRuntime(
    journal,
    projections,
    checkpoints,
    serialiseRun,
    definitions,
  );
}

export type { DeliveryIntentView };
