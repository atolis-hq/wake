import { ResidentHost, TickHost, type AdvanceOnce } from '../control-plane/index.js';
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
import { createRuntimeProjectionRunner } from './projection-runtime.js';

export function composeDeliveryService(dependencies: DeliveryServiceDependencies): DeliveryService {
  return new DeliveryService(dependencies);
}

export function composeDeliveryOutcomeReactor(
  journal: EventJournal,
  checkpoints: CheckpointStore,
  orchestration: Pick<OrchestrationService, 'acceptOutcome' | 'get'>,
): DeliveryOutcomeReactor {
  return new DeliveryOutcomeReactor(journal, checkpoints, orchestration);
}

export interface DeliveryRuntimeDependencies {
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
  readonly resource: DeliveryResourceLookup;
  readonly adapter: (name: string) => ExternalDeliveryAdapter;
  readonly now: () => string;
  readonly orchestration: Pick<OrchestrationService, 'acceptOutcome' | 'get'>;
}

export function composeDeliveryRuntime(dependencies: DeliveryRuntimeDependencies) {
  const projectionRunner = createRuntimeProjectionRunner(
    dependencies.journal,
    dependencies.projections,
    dependencies.checkpoints,
  );
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
    dependencies.checkpoints,
    dependencies.orchestration,
  );
  return {
    async runOnce(signal: AbortSignal) {
      await projectionRunner.runRegisteredOnce();
      const delivered = await service.deliverNext(signal);
      await projectionRunner.runRegisteredOnce();
      await reactor.runOnce();
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

export * from './composition-root.js';

export * from './analytics-projection.js';

export * from './board-projection.js';

export * from './config/load-config.js';

export * from './initialise.js';

export * from './config/root-schema.js';

export * from './fake-scenarios.js';

export * from './paths.js';

export * from './projection-runtime.js';

export * from './surface-applications.js';

export * from './update-ledger.js';

export * from './self-update-application.js';

export * from './source-update-port.js';
