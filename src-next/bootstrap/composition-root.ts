import {
  ActivityExecutionKind,
  ActivityOutcomeKind,
  ActivityRegistry,
  activityName,
  agentActivityDefinition,
  createPullRequestApproveActivity,
  createPullRequestMergeActivity,
  createPullRequestService,
  type ActivityDefinition,
} from '../activities/index.js';
import {
  createAdvanceOnce,
  createTickPipeline,
  type TickPipeline,
} from '../control-plane/index.js';
import { createExecutionService, FakeExecutionRunner, RunnerRegistry } from '../execution/index.js';
import {
  SystemClock,
  UlidIdGenerator,
  type Clock,
  type CheckpointStore,
  type EventJournal,
  type ProjectionStore,
} from '../kernel/index.js';
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProjectionStore,
} from '../persistence/index.js';
import {
  compileWorkflow,
  createOrchestrationService,
  createWatchReactor,
} from '../orchestration/index.js';
import {
  createResourceLookup,
  createResourceService,
  resourceId,
  resourceStream,
} from '../resources/index.js';
import {
  DeliveryOutcomeReactor,
  DeliveryService,
  DeliveryIntentEventType,
  IntegrationStreamKind,
  PollService,
  ProviderRegistry,
  fakeProviderDefinition,
  type DeliveryIntentView,
  type ProviderInstance,
} from '../integrations/index.js';
import { createEventDraft, EventActorKind, EventSourceKind } from '../kernel/index.js';
import { z } from 'zod';
import { createWorkService } from '../work/index.js';
import { loadConfig, type ResolvedWakeModulesConfig } from './config/load-config.js';
import { resolveWakePaths, type WakePaths } from './paths.js';
import { createRuntimeProjectionRunner } from './projection-runtime.js';
import { hydrateFakeProviderEvidence } from './fake-provider-files.js';

export interface CompositionRootOptions {
  readonly config?: ResolvedWakeModulesConfig;
  readonly journal?: EventJournal;
  readonly projections?: ProjectionStore;
  readonly checkpoints?: CheckpointStore;
  readonly activities?: ActivityRegistry;
  readonly clock?: Clock;
}

export interface CompositionRoot {
  readonly config: ResolvedWakeModulesConfig;
  readonly paths: WakePaths;
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
  readonly activities: ActivityRegistry;
  readonly work: ReturnType<typeof createWorkService>;
  readonly resources: ReturnType<typeof createResourceService>;
  readonly orchestration: ReturnType<typeof createOrchestrationService>;
  readonly execution: ReturnType<typeof createExecutionService>;
  readonly advanceOnce: ReturnType<typeof createAdvanceOnce>;
  readonly projectionRunner: ReturnType<typeof createRuntimeProjectionRunner>;
  readonly providers: readonly ProviderInstance[];
  readonly delivery: DeliveryService;
  readonly pipeline: TickPipeline;
}

export async function createCompositionRoot(
  wakeRoot: string,
  options: CompositionRootOptions = {},
): Promise<CompositionRoot> {
  const config = options.config ?? (await loadConfig(wakeRoot));
  const paths = resolveWakePaths(wakeRoot);
  const clock = options.clock ?? new SystemClock();
  const ids = new UlidIdGenerator();
  const journal = options.journal ?? new FileEventJournal(paths.dataRoot, clock);
  const projections = options.projections ?? new FileProjectionStore(paths.dataRoot);
  const checkpoints = options.checkpoints ?? new FileCheckpointStore(paths.dataRoot);
  const work = createWorkService(journal);
  const lookup = createResourceLookup({ journal, projections });
  const resources = createResourceService(journal, lookup);
  const pullRequests = createPullRequestService(journal, work, resources);
  const activities = options.activities ?? createBuiltInActivityRegistry(journal, pullRequests);
  const definitions = Object.fromEntries(
    Object.entries(config.orchestration.workflows).map(([name, definition]) => [
      name,
      compileWorkflow(name, definition, activities, Object.keys(config.orchestration.workflows)),
    ]),
  );
  const orchestration = createOrchestrationService(journal, work, definitions);
  const execution = createExecutionService(journal, activities, config.execution, {
    clock,
    ids,
    runners: createRunnerRegistry(config.execution),
  });
  const advanceOnce = createAdvanceOnce(orchestration, execution, resources, clock, ids);
  const runtime = await composeIntegrationRuntime({
    config,
    journal,
    projections,
    checkpoints,
    resources,
    pullRequests,
    orchestration,
    advanceOnce,
    clock,
    work,
    ids,
    wakeRoot,
  });
  return {
    config,
    paths,
    journal,
    projections,
    checkpoints,
    activities,
    work,
    resources,
    orchestration,
    execution,
    advanceOnce,
    ...runtime,
  };
}

interface IntegrationRuntime {
  readonly projectionRunner: ReturnType<typeof createRuntimeProjectionRunner>;
  readonly providers: readonly ProviderInstance[];
  readonly delivery: DeliveryService;
  readonly pipeline: TickPipeline;
}

interface IntegrationRuntimeInput {
  readonly config: ResolvedWakeModulesConfig;
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
  readonly resources: ReturnType<typeof createResourceService>;
  readonly pullRequests: ReturnType<typeof createPullRequestService>;
  readonly work: ReturnType<typeof createWorkService>;
  readonly orchestration: ReturnType<typeof createOrchestrationService>;
  readonly advanceOnce: ReturnType<typeof createAdvanceOnce>;
  readonly clock: Clock;
  readonly ids: UlidIdGenerator;
  readonly wakeRoot: string;
}

async function composeIntegrationRuntime(
  input: IntegrationRuntimeInput,
): Promise<IntegrationRuntime> {
  const registry = new ProviderRegistry();
  registry.register(fakeProviderDefinition);
  const providers = registry.compose(
    await hydrateFakeProviderEvidence(input.wakeRoot, input.config.integrations),
    {
      work: input.work,
      resources: input.resources,
      pullRequests: input.pullRequests,
      orchestration: input.orchestration,
      ids: input.ids,
      clock: input.clock,
      journal: input.journal,
      checkpoints: input.checkpoints,
      defaultWorkflow: Object.keys(input.config.orchestration.workflows)[0] ?? 'default',
    },
  );
  const projectionRunner = createRuntimeProjectionRunner(
    input.journal,
    input.projections,
    input.checkpoints,
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
  const watch = createWatchReactor(input.orchestration, input.journal, input.checkpoints);
  const outcomes = new DeliveryOutcomeReactor(
    input.journal,
    input.checkpoints,
    input.orchestration,
  );
  const pipeline = createTickPipeline({
    catchUpProjections: async () => {
      await projectionRunner.runRegisteredOnce();
    },
    poll: async (signal) => {
      for (const provider of providers)
        await new PollService(input.journal, provider).pollOnce(signal);
    },
    translateInbound: async () => {
      for (const provider of providers) await provider.inbound.runOnce();
    },
    react: async () => {
      await watch.runOnce();
      await outcomes.runOnce();
    },
    advance: input.advanceOnce,
    deliver: async (signal) => {
      await delivery.deliverNext(signal);
    },
  });
  return { projectionRunner, providers, delivery, pipeline };
}

function createBuiltInActivityRegistry(
  journal: EventJournal,
  pullRequests: ReturnType<typeof createPullRequestService>,
): ActivityRegistry {
  const activities = new ActivityRegistry();
  activities.register(agentActivityDefinition);
  activities.register(statusPublishActivity(journal));
  activities.register(createPullRequestApproveActivity(journal, pullRequests));
  activities.register(createPullRequestMergeActivity(journal, pullRequests));
  return activities;
}

function statusPublishActivity(
  journal: EventJournal,
): ActivityDefinition<
  ReturnType<typeof activityName>,
  { body: string },
  { kind: typeof ActivityOutcomeKind.Done }
> {
  return {
    name: activityName('status.publish'),
    inputSchema: z.object({ body: z.string().min(1) }).strict(),
    outcomeSchema: z.object({ kind: z.literal(ActivityOutcomeKind.Done) }).strict(),
    outcomeKinds: [ActivityOutcomeKind.Done],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      async execute(invocation) {
        const resource = invocation.resources[0];
        if (resource === undefined) throw new Error('status.publish requires an intake resource');
        const sequence = (await journal.readStream(resourceStream(resource.resourceId))).length;
        await journal.append(resourceStream(resource.resourceId), sequence, [
          createEventDraft({
            eventId: `${invocation.activationId}:status.publish`,
            eventType: DeliveryIntentEventType.StatusPublishRequested,
            occurredAt: new Date().toISOString(),
            correlationId: invocation.causationId,
            causationId: invocation.causationId,
            actor: { kind: EventActorKind.System, id: 'status.publish' },
            source: { kind: EventSourceKind.Internal, id: 'status.publish' },
            stream: resourceStream(resource.resourceId),
            payload: {
              workflowInstanceId: invocation.workflowInstanceId,
              activationId: invocation.activationId,
              resourceId: resource.resourceId,
              body: invocation.input.body,
            },
          }),
        ]);
        return { kind: ActivityOutcomeKind.Done };
      },
    },
  };
}

function createRunnerRegistry(config: ResolvedWakeModulesConfig['execution']): RunnerRegistry {
  const runners = Object.fromEntries(
    Object.entries(config.agentRunners ?? {}).flatMap(([name, runner]) =>
      runner.kind === 'fake' ? [[name, new FakeExecutionRunner()]] : [],
    ),
  );
  return new RunnerRegistry(config.tiers, runners);
}
