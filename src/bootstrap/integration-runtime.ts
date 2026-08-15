import type { createPullRequestService } from '../activities/index.js';
import {
  ControlStreamKind,
  ScheduleService,
  createIntakePipeline,
  createRunnerPipeline,
  createWorkCancellationPolicy,
  type AdvanceOnce,
  type IntakePipeline,
  type RunnerPipeline,
  type ScheduleCheckpointStore,
  type createControlPlaneService,
} from '../control-plane/index.js';
import { RunRepository, type createExecutionService } from '../execution/index.js';
import {
  AgentRunPublicationReactor,
  ArtifactRegistrationReactor,
  DeliveryOutcomeReactor,
  DeliveryService,
  IntegrationStreamKind,
  PollService,
  ProviderRegistry,
  fakeProviderDefinition,
  type DeliveryIntentView,
  type DurableFakeDeliveryProvider,
  type ExternalDeliveryAdapter,
  type ProviderCompositionFailure,
  type ProviderDefinition,
  type ProviderInstance,
  type WorkflowRouter,
} from '../integrations/index.js';
import {
  EventActorKind,
  type CheckpointStore,
  type Clock,
  type EventJournal,
  type ProjectionStore,
  type UlidIdGenerator,
} from '../kernel/index.js';
import {
  compileWorkflowSelectors,
  createPullRequestTransitionEvidence,
  createResourceTransitionReactor,
  createWatchReactor,
  selectWorkflow,
  workflowName,
  type createOrchestrationService,
} from '../orchestration/index.js';
import {
  BuiltInResourceCapability,
  resourceId,
  type createResourceLookup,
  type createResourceService,
} from '../resources/index.js';
import type { createWorkService } from '../work/index.js';
import type { ResolvedWakeModulesConfig } from './config/load-config.js';
import { hydrateFakeProviderEvidence } from './fake-provider-files.js';
import { createRuntimeProjectionRunner } from './projection-runtime.js';
import { createCapabilityResourceTransitionEvidence } from './resource-transition-evidence.js';

export interface IntegrationRuntime {
  readonly projectionRunner: ReturnType<typeof createRuntimeProjectionRunner>;
  readonly providers: readonly ProviderInstance[];
  readonly providerFailures: readonly ProviderCompositionFailure[];
  readonly delivery: DeliveryService;
  readonly intakePipeline: IntakePipeline;
  readonly runnerPipeline: RunnerPipeline;
}

export interface IntegrationRuntimeInput {
  readonly config: ResolvedWakeModulesConfig;
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
  readonly resources: ReturnType<typeof createResourceService>;
  readonly lookup: ReturnType<typeof createResourceLookup>;
  readonly pullRequests: ReturnType<typeof createPullRequestService>;
  readonly work: ReturnType<typeof createWorkService>;
  readonly orchestration: ReturnType<typeof createOrchestrationService>;
  readonly execution: ReturnType<typeof createExecutionService>;
  readonly advanceOnce: AdvanceOnce;
  readonly controlPlane: ReturnType<typeof createControlPlaneService>;
  readonly isPaused: () => Promise<boolean>;
  readonly clock: Clock;
  readonly ids: UlidIdGenerator;
  readonly wakeRoot: string;
  readonly scheduleCheckpoints: ScheduleCheckpointStore;
  readonly decorateDeliveryAdapter?: (
    adapter: ExternalDeliveryAdapter,
    provider: ProviderInstance,
  ) => ExternalDeliveryAdapter;
  readonly fakeDeliveryProvider?: DurableFakeDeliveryProvider;
  readonly providerDefinitions: readonly ProviderDefinition[];
}

function serializeRunRegisteredOnce(
  runner: ReturnType<typeof createRuntimeProjectionRunner>,
): ReturnType<typeof createRuntimeProjectionRunner> {
  let queue: Promise<unknown> = Promise.resolve();
  const runRegisteredOnce = runner.runRegisteredOnce.bind(runner);
  runner.runRegisteredOnce = (limit?: number) => {
    const result = queue.then(() => runRegisteredOnce(limit));
    queue = result.catch(() => {});
    return result;
  };
  return runner;
}

export async function composeIntegrationRuntime(
  input: IntegrationRuntimeInput,
): Promise<IntegrationRuntime> {
  const registry = new ProviderRegistry();
  registry.register(fakeProviderDefinition);
  for (const definition of input.providerDefinitions) registry.register(definition);
  const { instances, failures: providerFailures } = registry.compose(
    await hydrateFakeProviderEvidence(input.wakeRoot, input.config.integrations),
    {
      work: input.work,
      resources: input.resources,
      resourceLookup: input.lookup,
      pullRequests: input.pullRequests,
      runs: new RunRepository(input.journal),
      orchestration: input.orchestration,
      ids: input.ids,
      clock: input.clock,
      journal: input.journal,
      checkpoints: input.checkpoints,
      routing: createWorkflowRouter(input.config.orchestration),
      conclusion: createWorkCancellationPolicy(
        input.work,
        input.orchestration,
        input.execution,
        input.clock,
        input.ids,
      ),
    },
  );
  const composedProviders =
    input.fakeDeliveryProvider === undefined
      ? instances
      : instances.map((provider) =>
          provider.adapter === 'fake'
            ? { ...provider, delivery: input.fakeDeliveryProvider! }
            : provider,
        );
  const providers = input.decorateDeliveryAdapter
    ? composedProviders.map((provider) => ({
        ...provider,
        delivery: input.decorateDeliveryAdapter!(provider.delivery, provider),
      }))
    : composedProviders;
  // FileCheckpointStore.save throws on any regression (persistence/filesystem/
  // file-checkpoint-store.ts), so two concurrent runRegisteredOnce calls that
  // interleave can race a slower caller's stale checkpoint save against a
  // faster one that already advanced past it. Every caller (the tick
  // pipeline's own catchUpProjections, the API's manual tick, and the
  // resident's standalone projection pump) shares this one instance, so
  // serializing it here in-process covers all of them without a file lock.
  const projectionRunner = serializeRunRegisteredOnce(
    createRuntimeProjectionRunner(input.journal, input.projections, input.checkpoints),
  );
  const delivery = new DeliveryService({
    journal: input.journal,
    intents: async () =>
      (await input.projections.list<DeliveryIntentView>(IntegrationStreamKind.Delivery)).map(
        ({ value }) => value,
      ),
    resource: async (id) => {
      const resource = await input.resources.get(resourceId(id));
      return resource === null
        ? null
        : { resourceId: resource.resourceId, adapter: resource.externalKey.adapter };
    },
    adapter: (name) => {
      const provider = providers.find((candidate) => candidate.adapter === name);
      if (provider === undefined) throw new Error(`Delivery provider ${name} is not configured`);
      return provider.delivery;
    },
    now: () => input.clock.now().toISOString(),
  });
  const schedules = new ScheduleService({
    checkpoint: input.scheduleCheckpoints,
    ids: input.ids,
    work: input.work,
    orchestration: input.orchestration,
    now: () => input.clock.now().toISOString(),
  });
  const artifacts = new ArtifactRegistrationReactor({
    journal: input.journal,
    checkpoints: input.checkpoints,
    resources: input.resources,
    ids: input.ids,
    providers,
    runs: input.execution,
  });
  const runs = new RunRepository(input.journal);
  const agentRunPublications = new AgentRunPublicationReactor({
    journal: input.journal,
    checkpoints: input.checkpoints,
    runs,
    resources: input.resources,
    orchestration: input.orchestration,
  });
  const watch = createWatchReactor(input.orchestration, input.journal, input.checkpoints, runs);
  const resourceTransitions = createResourceTransitionReactor(
    input.orchestration,
    createCapabilityResourceTransitionEvidence({
      resources: input.resources,
      policies: [
        {
          capabilities: [
            BuiltInResourceCapability.Mergeable,
            BuiltInResourceCapability.Reviewable,
            BuiltInResourceCapability.Approvable,
          ],
          policy: createPullRequestTransitionEvidence(input.pullRequests),
        },
      ],
    }),
    input.journal,
    input.checkpoints,
  );
  input.orchestration.setPreAcceptSignalBarrier(() => resourceTransitions.drain());
  const outcomes = new DeliveryOutcomeReactor(
    input.journal,
    input.checkpoints,
    input.orchestration,
  );
  const catchUpProjections = async () => {
    await projectionRunner.runRegisteredOnce();
  };
  // Only poll hits a rate-limited external API, so only this half of the
  // Tick needs a backing-off host; see bootstrap/surface-cli-applications.ts.
  const intakePipeline = createIntakePipeline({
    isPaused: input.isPaused,
    catchUpProjections,
    poll: async (signal) => {
      let appended = 0;
      for (const provider of providers)
        appended += await new PollService(input.journal, provider).pollOnce(signal);
      return appended;
    },
    translateInbound: async () => {
      let translated = 0;
      for (const provider of providers) translated += await provider.inbound.runOnce();
      return translated;
    },
  });
  const runnerPipeline = createRunnerPipeline({
    isPaused: input.isPaused,
    catchUpProjections,
    runSchedules: async () => {
      for (const schedule of input.config.controlPlane.schedules)
        await schedules.run(schedule, {
          commandId: input.ids.next('command'),
          correlationId: 'schedule-tick' as never,
          occurredAt: input.clock.now().toISOString(),
          actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
        });
    },
    react: async () => {
      await watch.runOnce();
      await resourceTransitions.runOnce();
      await artifacts.runOnce();
      await outcomes.runOnce();
      for (const provider of providers) await provider.maintenance?.runOnce();
    },
    advance: input.advanceOnce,
    publishAgentRuns: async () => {
      await agentRunPublications.runOnce();
    },
    deliver: async (signal) => {
      await delivery.deliverNext(signal);
    },
  });
  return {
    projectionRunner,
    providers,
    providerFailures,
    delivery,
    intakePipeline,
    runnerPipeline,
  };
}

// Configuration is the only routing authority: adapters ask, they never propose.
function createWorkflowRouter(
  orchestration: ResolvedWakeModulesConfig['orchestration'],
): WorkflowRouter {
  const selectors = compileWorkflowSelectors(orchestration.workflowSelectors);
  const fallback = workflowName(orchestration.default);
  return { select: (candidate) => selectWorkflow(candidate, selectors, fallback) };
}
