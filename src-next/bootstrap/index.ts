import { activityProjectionDefinitions } from '../activities/index.js';
import {
  DeliveryOutcomeReactor,
  DeliveryService,
  deliveryProjectionDefinitions,
  type ExternalDeliveryAdapter,
  type DeliveryIntentView,
  type DeliveryResourceLookup,
  type DeliveryServiceDependencies,
} from '../integrations/index.js';
import type { OrchestrationService } from '../orchestration/index.js';
import type { CheckpointStore, EventJournal, ProjectionStore } from '../kernel/index.js';
import { ProjectionRunner } from '../persistence/index.js';
import { resourceCorrelationProjection, resourceProjection } from '../resources/index.js';
import { workProjection } from '../work/index.js';
import { controlPlaneProjectionDefinitions } from '../control-plane/index.js';
import { ResidentHost, TickHost, type AdvanceOnce } from '../control-plane/index.js';

export const runtimeProjectionDefinitions = [
  workProjection,
  resourceProjection,
  resourceCorrelationProjection,
  ...activityProjectionDefinitions,
  ...deliveryProjectionDefinitions,
  ...controlPlaneProjectionDefinitions,
];

export function composeDeliveryService(dependencies: DeliveryServiceDependencies): DeliveryService {
  return new DeliveryService(dependencies);
}

export function composeDeliveryOutcomeReactor(
  journal: EventJournal,
  checkpoints: CheckpointStore,
  orchestration: Pick<OrchestrationService, 'acceptOutcome'>,
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
  readonly orchestration: Pick<OrchestrationService, 'acceptOutcome'>;
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

export function createRuntimeProjectionRunner(
  journal: EventJournal,
  projections: ProjectionStore,
  checkpoints: CheckpointStore,
): ProjectionRunner {
  return new ProjectionRunner(journal, projections, checkpoints, runtimeProjectionDefinitions);
}

export function composeControlPlaneHosts(
  advanceOnce: AdvanceOnce,
  sleep?: (signal: AbortSignal) => Promise<void>,
) {
  const tick = new TickHost(advanceOnce);
  return { tick, resident: new ResidentHost(tick, sleep) };
}
