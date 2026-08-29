import { join } from 'node:path';
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
import type { createConversationService } from '../conversations/index.js';
import {
  RunRepository,
  createRuntimeMemoryProfile,
  type RuntimeMemoryProfile,
  type createExecutionService,
} from '../execution/index.js';
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
import { withFileLock, type ProjectionRunSerialiser } from '../persistence/index.js';
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
  readonly conversations: ReturnType<typeof createConversationService>;
  readonly orchestration: ReturnType<typeof createOrchestrationService>;
  readonly execution: ReturnType<typeof createExecutionService>;
  readonly advanceOnce: AdvanceOnce;
  readonly inlineActivationScheduling: boolean;
  readonly controlPlane: ReturnType<typeof createControlPlaneService>;
  readonly isPaused: () => Promise<boolean>;
  readonly clock: Clock;
  readonly ids: UlidIdGenerator;
  readonly wakeRoot: string;
  readonly projectionRunSerialiser?: ProjectionRunSerialiser;
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
  const memoryProfile =
    process.env.WAKE_MEMORY_PROFILE === 'runner'
      ? createRuntimeMemoryProfile({
          write: (line) => process.stderr.write(line),
          now: () => input.clock.now().toISOString(),
          memoryUsage: () => process.memoryUsage(),
        })
      : undefined;
  const registry = new ProviderRegistry();
  registry.register(fakeProviderDefinition);
  for (const definition of input.providerDefinitions) registry.register(definition);
  const { instances, failures: providerFailures } = registry.compose(
    await hydrateFakeProviderEvidence(input.wakeRoot, input.config.integrations),
    {
      publicUiUrl: input.config.surfaces.web.publicUrl,
      work: input.work,
      conversations: input.conversations,
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
    createRuntimeProjectionRunner(
      input.journal,
      input.projections,
      input.checkpoints,
      input.projectionRunSerialiser,
    ),
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
      return provider?.delivery ?? null;
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
  const replies = providers.find(
    (provider) => provider.replyPublication !== undefined,
  )?.replyPublication;
  const agentRunPublications = new AgentRunPublicationReactor({
    journal: input.journal,
    checkpoints: input.checkpoints,
    runs,
    resources: input.resources,
    orchestration: input.orchestration,
    conversations: input.conversations,
    ...(replies === undefined ? {} : { replies }),
  });
  const watch = createWatchReactor(input.orchestration, input.journal, input.checkpoints, runs);
  const resourceTransitionEvidence = createCapabilityResourceTransitionEvidence({
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
  });
  const resourceTransitions = createResourceTransitionReactor(
    input.orchestration,
    resourceTransitionEvidence,
    input.journal,
    input.checkpoints,
  );
  input.orchestration.setAcceptSignalOperationCoordinator(async (operation) => {
    await resourceTransitions.drain();
    return operation();
  });
  const outcomes = new DeliveryOutcomeReactor(
    input.journal,
    input.checkpoints,
    input.orchestration,
    input.projections,
    input.conversations,
  );
  const catchUpProjections = async () => {
    await projectionRunner.runRegisteredOnce();
  };
  // Only poll hits a rate-limited external API, so only this half of the
  // Tick needs a backing-off host; see bootstrap/surface-cli-applications.ts.
  const intakePipeline = createIntakePipeline({
    isPaused: input.isPaused,
    catchUpProjections: () =>
      observeMemory(memoryProfile, 'intake.projections', catchUpProjections),
    poll: async (signal) => {
      return observeMemory(memoryProfile, 'intake.poll', async () => {
        let appended = 0;
        for (const provider of providers)
          appended += await withFileLock(
            join(input.wakeRoot, '.wake', 'locks', `poll-${provider.adapter}.lock`),
            async () => (await new PollService(input.journal, provider).pollOnce(signal)).appended,
          );
        return appended;
      });
    },
    translateInbound: async () => {
      return observeMemory(memoryProfile, 'intake.translate', async () => {
        let translated = 0;
        for (const provider of providers) translated += await provider.inbound.runOnce();
        return translated;
      });
    },
  });
  const runnerPipeline = createRunnerPipeline({
    isPaused: input.isPaused,
    catchUpProjections: () =>
      observeMemory(memoryProfile, 'runner.projections', catchUpProjections),
    runSchedules: () =>
      observeMemory(memoryProfile, 'runner.schedules', async () => {
        for (const schedule of input.config.controlPlane.schedules)
          await schedules.run(schedule, {
            commandId: input.ids.next('command'),
            correlationId: 'schedule-tick' as never,
            occurredAt: input.clock.now().toISOString(),
            actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
          });
      }),
    react: () =>
      observeMemory(memoryProfile, 'runner.react', async () => {
        await watch.runOnce();
        await watch.reconcileOnce();
        await resourceTransitions.runOnce();
        await artifacts.runOnce();
        await outcomes.runOnce();
        for (const provider of providers) await provider.maintenance?.runOnce();
      }),
    advance: (options) =>
      observeMemory(memoryProfile, 'runner.advance', () => input.advanceOnce(options)),
    inlineActivationScheduling: input.inlineActivationScheduling,
    publishAgentRuns: () =>
      observeMemory(memoryProfile, 'runner.publish-agent-runs', async () => {
        await agentRunPublications.runOnce();
      }),
    deliver: (signal) =>
      observeMemory(memoryProfile, 'runner.deliver', async () => {
        await delivery.deliverNext(signal);
      }),
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

async function observeMemory<T>(
  profile: RuntimeMemoryProfile | undefined,
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  profile?.sample(`${phase}.before`);
  try {
    return await operation();
  } finally {
    profile?.sample(`${phase}.settled`);
  }
}

// Configuration is the only routing authority: adapters ask, they never propose.
function createWorkflowRouter(
  orchestration: ResolvedWakeModulesConfig['orchestration'],
): WorkflowRouter {
  const selectors = compileWorkflowSelectors(orchestration.workflowSelectors);
  const fallback = workflowName(orchestration.default);
  return { select: (candidate) => selectWorkflow(candidate, selectors, fallback) };
}
