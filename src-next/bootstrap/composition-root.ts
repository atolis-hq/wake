import {
  ActivityRegistry,
  agentActivityDefinition,
  createAgentActivity,
  createPullRequestApproveActivity,
  createPullRequestMergeActivity,
  createPullRequestService,
} from '../activities/index.js';
import {
  ControlStreamKind,
  DispatchPolicy,
  ScheduleService,
  createAdvanceOnce,
  createRunnerControlService,
  createTickPipeline,
  ineligibleRunners,
  type ControlPlaneView,
  type TickPipeline,
} from '../control-plane/index.js';
import {
  RunRepository,
  createExecutionService,
  GitWorkspaceProvider,
  loadPromptTemplate,
  renderPromptTemplate,
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
  type ProviderInstance,
  type WorkflowRouter,
} from '../integrations/index.js';
import {
  EventActorKind,
  SystemClock,
  UlidIdGenerator,
  type CheckpointStore,
  type Clock,
  type EventJournal,
  type ProjectionStore,
} from '../kernel/index.js';
import {
  compileWorkflow,
  compileWorkflowSelectors,
  createOrchestrationService,
  createWatchReactor,
  selectWorkflow,
  workflowName,
} from '../orchestration/index.js';
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProjectionStore,
} from '../persistence/index.js';
import { createResourceLookup, createResourceService, resourceId } from '../resources/index.js';
// The shared Integration barrel must not re-export a provider namespace
// (see provider-locality); composition-root is the exempt production
// composition point that is allowed to name it directly.
import { gitHubProviderDefinition } from '../integrations/github/index.js';
import { createWorkService } from '../work/index.js';
import { loadConfig, type ResolvedWakeModulesConfig } from './config/load-config.js';
import { hydrateFakeProviderEvidence } from './fake-provider-files.js';
import { loadFakeScenarios } from './fake-scenarios.js';
import { resolveWakePaths, type WakePaths } from './paths.js';
import { createRuntimeProjectionRunner } from './projection-runtime.js';
import { createRunnerQuotaReporter } from './runner-quota-reporter.js';
import { createRunnerRegistry } from './runner-registry.js';
import { FileScheduleCheckpointStore } from './schedule-checkpoint-store.js';
import { createStatusPublishActivity } from './status-publish-activity.js';

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
  readonly fakeScenarios: import('../execution/index.js').FakeScenarioResolver;
  readonly paths: WakePaths;
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
  readonly activities: ActivityRegistry;
  readonly work: ReturnType<typeof createWorkService>;
  readonly resources: ReturnType<typeof createResourceService>;
  readonly lookup: ReturnType<typeof createResourceLookup>;
  readonly orchestration: ReturnType<typeof createOrchestrationService>;
  readonly execution: ReturnType<typeof createExecutionService>;
  readonly runnerControls: ReturnType<typeof createRunnerControlService>;
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
  const fakeScenarios = await loadFakeScenarios(wakeRoot);
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
  const activities =
    options.activities ?? createBuiltInActivityRegistry(journal, pullRequests, wakeRoot);
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
    runners: createRunnerRegistry(config.execution, fakeScenarios),
    reportRunnerQuota: createRunnerQuotaReporter(journal, clock, ids),
    workspaces: new GitWorkspaceProvider(paths.workspacesRoot, {
      async cloneLocator(id) {
        const resource = await resources.get(resourceId(id));
        const match = resource === null ? null : /^([^/]+\/[^#]+)#\d+$/.exec(resource.externalKey.key);
        if (match === null) throw new Error('Workspace resource ' + id + ' does not identify a GitHub repository');
        return 'https://github.com/' + match[1] + '.git';
      },
    }),
  });
  const runnerControls = createRunnerControlService({
    journal,
    clock,
    ids,
    runners: new Set(Object.values(config.execution.runnerPools).flat()),
  });
  const advanceOnce = createAdvanceOnce(orchestration, execution, resources, clock, {
    ids,
    dispatchPolicy: new DispatchPolicy({ maxDispatches: config.controlPlane.maxDispatches }),
    isDispatchPaused: async () => {
      const stored = await projections.read<ControlPlaneView>(ControlStreamKind.Global, 'global');
      return stored !== null && stored.value.pausedUntil !== null;
    },
    runnerIneligibility: async () => {
      const stored = await projections.read<ControlPlaneView>(ControlStreamKind.Global, 'global');
      return stored === null
        ? new Set()
        : ineligibleRunners(stored.value, clock.now().toISOString());
    },
  });
  const runtime = await composeIntegrationRuntime({
    config,
    journal,
    projections,
    checkpoints,
    resources,
    lookup,
    pullRequests,
    orchestration,
    execution,
    advanceOnce,
    clock,
    work,
    ids,
    wakeRoot,
  });
  return {
    config,
    fakeScenarios,
    paths,
    journal,
    projections,
    checkpoints,
    activities,
    work,
    resources,
    lookup,
    orchestration,
    execution,
    runnerControls,
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
  readonly lookup: ReturnType<typeof createResourceLookup>;
  readonly pullRequests: ReturnType<typeof createPullRequestService>;
  readonly work: ReturnType<typeof createWorkService>;
  readonly orchestration: ReturnType<typeof createOrchestrationService>;
  readonly execution: ReturnType<typeof createExecutionService>;
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
  registry.register(gitHubProviderDefinition);
  const providers = registry.compose(
    await hydrateFakeProviderEvidence(input.wakeRoot, input.config.integrations),
    {
      work: input.work,
      resources: input.resources,
      resourceLookup: input.lookup,
      pullRequests: input.pullRequests,
      orchestration: input.orchestration,
      ids: input.ids,
      clock: input.clock,
      journal: input.journal,
      checkpoints: input.checkpoints,
      routing: createWorkflowRouter(input.config.orchestration),
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
  const schedules = new ScheduleService({
    checkpoint: new FileScheduleCheckpointStore(resolveWakePaths(input.wakeRoot).dataRoot),
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
  const agentRunPublications = new AgentRunPublicationReactor({ journal: input.journal, checkpoints: input.checkpoints, runs: new RunRepository(input.journal), resources: input.resources, orchestration: input.orchestration });
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
    runSchedules: async () => {
      for (const schedule of input.config.controlPlane.schedules)
        await schedules.run(schedule, {
          commandId: input.ids.next('command'),
          correlationId: 'schedule-tick' as never,
          occurredAt: input.clock.now().toISOString(),
          actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
        });
    },
    translateInbound: async () => {
      for (const provider of providers) await provider.inbound.runOnce();
    },
    react: async () => {
      await watch.runOnce();
      await artifacts.runOnce();
      await agentRunPublications.runOnce();
      await outcomes.runOnce();
      for (const provider of providers) await provider.maintenance?.runOnce();
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
  wakeRoot: string,
): ActivityRegistry {
  const activities = new ActivityRegistry();
  activities.register({
    ...agentActivityDefinition,
    handler: createAgentActivity({
      async render(name, context) {
        const template = await loadPromptTemplate(wakeRoot, name);
        return {
          prompt: renderPromptTemplate(template, context),
          ...(template.frontmatter.model === undefined || template.frontmatter.model === null
            ? {}
            : { model: template.frontmatter.model }),
          ...(template.frontmatter.allowedTools === undefined ||
          template.frontmatter.allowedTools === null
            ? {}
            : { allowedTools: template.frontmatter.allowedTools }),
          ...(template.frontmatter.maxTurns === undefined
            ? {}
            : { maxTurns: template.frontmatter.maxTurns }),
        };
      },
    }),
  });
  activities.register(createStatusPublishActivity(journal));
  activities.register(createPullRequestApproveActivity(journal, pullRequests));
  activities.register(createPullRequestMergeActivity(journal, pullRequests));
  return activities;
}

// Configuration is the only routing authority: adapters ask, they never propose.
function createWorkflowRouter(
  orchestration: ResolvedWakeModulesConfig['orchestration'],
): WorkflowRouter {
  const selectors = compileWorkflowSelectors(orchestration.workflowSelectors);
  const fallback = workflowName(orchestration.default);
  return { select: (candidate) => selectWorkflow(candidate, selectors, fallback) };
}
