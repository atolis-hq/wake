import {
  ActivityRegistry,
  createAgentActivity,
  agentActivityDefinition,
  createPullRequestApproveActivity,
  createPullRequestMergeActivity,
  createPullRequestService,
} from '../activities/index.js';
import {
  createAdvanceOnce,
  createTickPipeline,
  type TickPipeline,
} from '../control-plane/index.js';
import {
  createExecutionService,
  loadPromptTemplate,
  renderPromptTemplate,
} from '../execution/index.js';
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
  compileWorkflowSelectors,
  createOrchestrationService,
  createWatchReactor,
  selectWorkflow,
  workflowName,
} from '../orchestration/index.js';
import { createResourceLookup, createResourceService, resourceId } from '../resources/index.js';
import {
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
// The shared Integration barrel must not re-export a provider namespace
// (see provider-locality); composition-root is the exempt production
// composition point that is allowed to name it directly.
import { gitHubProviderDefinition } from '../integrations/github/index.js';
import { createWorkService } from '../work/index.js';
import { loadConfig, type ResolvedWakeModulesConfig } from './config/load-config.js';
import { resolveWakePaths, type WakePaths } from './paths.js';
import { createRuntimeProjectionRunner } from './projection-runtime.js';
import { createRunnerRegistry } from './runner-registry.js';
import { hydrateFakeProviderEvidence } from './fake-provider-files.js';
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
  registry.register(gitHubProviderDefinition);
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
