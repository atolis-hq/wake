import { ResidentHost, TickHost, type AdvanceOnce } from '../control-plane/index.js';
import type { ConversationService } from '../conversations/index.js';
import {
  DeliveryOutcomeReactor,
  deliveryProjectionDefinitions,
  DeliveryService,
  type DeliveryIntentView,
  type DeliveryResourceLookup,
  type DeliveryServiceDependencies,
  type ExternalDeliveryAdapter,
} from '../integrations/index.js';
import type { CheckpointStore, EventJournal, ProjectionStore } from '../kernel/index.js';
import type { OrchestrationService } from '../orchestration/index.js';
import { createInMemoryProcessorRunSerialiser } from '../persistence/index.js';
import type { CompositionRoot, CompositionRootOptions } from './composition-root.js';
import { EventProcessorRuntime } from './event-processor-runtime.js';
import { createRuntimeProjectionSubscriptions } from './projection-runtime.js';
import type { SurfaceApplicationOptions } from './surface-applications.js';

export function composeDeliveryService(dependencies: DeliveryServiceDependencies): DeliveryService {
  return new DeliveryService(dependencies);
}

export function composeDeliveryOutcomeReactor(
  journal: EventJournal,
  orchestration: Pick<OrchestrationService, 'acceptOutcome' | 'get'>,
  projections: ProjectionStore,
  conversations?: Pick<ConversationService, 'recordRepresentation'>,
): DeliveryOutcomeReactor {
  return new DeliveryOutcomeReactor(journal, orchestration, projections, conversations);
}

export interface DeliveryRuntimeDependencies {
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
  readonly resource: DeliveryResourceLookup;
  readonly adapter: (name: string) => ExternalDeliveryAdapter;
  readonly now: () => string;
  readonly orchestration: Pick<OrchestrationService, 'acceptOutcome' | 'get'>;
  readonly conversations?: Pick<ConversationService, 'recordRepresentation'>;
}

export function composeDeliveryRuntime(dependencies: DeliveryRuntimeDependencies) {
  const service = composeDeliveryService({
    journal: dependencies.journal,
    intents: async () =>
      (
        await dependencies.projections.list<DeliveryIntentView>(
          deliveryProjectionDefinitions[0]!.name,
        )
      ).map(({ value }) => value),
    resource: dependencies.resource,
    adapter: dependencies.adapter,
    now: dependencies.now,
  });
  const reactor = composeDeliveryOutcomeReactor(
    dependencies.journal,
    dependencies.orchestration,
    dependencies.projections,
    dependencies.conversations,
  );
  const processorRuntime = new EventProcessorRuntime(
    dependencies.journal,
    dependencies.checkpoints,
    createInMemoryProcessorRunSerialiser(),
  );
  const projectionSubscriptions = createRuntimeProjectionSubscriptions(
    dependencies.journal,
    dependencies.projections,
    dependencies.checkpoints,
    processorRuntime,
  );
  processorRuntime.register([...projectionSubscriptions.processors, reactor.processor]);
  return {
    async runOnce(signal: AbortSignal) {
      await projectionSubscriptions.catchUpOnce(signal);
      const delivered = await service.deliverNext(signal);
      await projectionSubscriptions.catchUpOnce(signal);
      await processorRuntime.catchUp('delivery outcomes', [reactor.processor], signal);
      await reactor.reconcileOnce();
      return delivered;
    },
  };
}

export function composeControlPlaneHosts(
  advanceOnce: AdvanceOnce,
  sleep?: (signal: AbortSignal) => Promise<void>,
) {
  const tick = new TickHost(advanceOnce);
  return { tick, resident: new ResidentHost(tick, sleep) };
}

export type { CompositionRoot, CompositionRootOptions } from './composition-root.js';

export async function createCompositionRoot(
  wakeRoot: string,
  options: CompositionRootOptions = {},
) {
  const { createCompositionRoot: create } = await import('./composition-root.js');
  return create(wakeRoot, options);
}

export * from './resource-transition-evidence.js';

export * from './analytics-projection.js';

export * from './activation-scheduler-serialiser.js';

export * from './board-projection.js';

export * from './config/load-config.js';

export * from './initialise.js';

export * from './config/root-schema.js';

export * from './fake-scenarios.js';

export * from './paths.js';

export * from './projection-runtime.js';

export * from './runner-tick-adapter.js';

export type { SurfaceApplicationOptions, SurfaceApplications } from './surface-applications.js';

export async function createSurfaceApplications(
  root: CompositionRoot,
  options: SurfaceApplicationOptions = {},
) {
  const { createSurfaceApplications: create } = await import('./surface-applications.js');
  return create(root, options);
}

export * from './update-ledger.js';

export * from './update-maintenance-lease.js';

export * from './self-update-application.js';

export * from './source-update-port.js';

export * from './version.js';
