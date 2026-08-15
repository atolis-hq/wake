import {
  ActivityRegistry,
  agentActivityDefinition,
  createAgentActivity,
  createIssueCompleteActivity,
  createPullRequestApproveActivity,
  createPullRequestMergeActivity,
  createPullRequestService,
} from '../activities/index.js';
import {
  ControlStreamKind,
  DispatchPolicy,
  ScheduleService,
  createAdvanceOnce,
  createControlPlaneService,
  createIntakePipeline,
  createRunnerControlService,
  createRunnerPipeline,
  createWorkCancellationPolicy,
  ineligibleRunners,
  type ControlPlaneView,
  type IntakePipeline,
  type RunnerPipeline,
  type ScheduleCheckpointStore,
} from '../control-plane/index.js';
import {
  ExternalExecutionState,
  GitWorkspaceProvider,
  RecoveryService,
  RunRepository,
  TranscriptStore,
  createExecutionService,
  loadPromptTemplate,
  renderPromptTemplate,
  type FakeScenarioResolver,
  type Runner,
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
  createPullRequestTransitionEvidence,
  createResourceTransitionReactor,
  createWatchReactor,
  selectWorkflow,
  workflowName,
} from '../orchestration/index.js';
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProjectionStore,
} from '../persistence/index.js';
import {
  BuiltInResourceCapability,
  createResourceLookup,
  createResourceService,
  resourceId,
  type ResourceLinkResolver,
} from '../resources/index.js';
import { createCapabilityResourceTransitionEvidence } from './resource-transition-evidence.js';
// The shared Integration barrel must not re-export a provider namespace
// (see provider-locality); composition-root is the exempt production
// composition point that is allowed to name it directly.
import {
  createGitHubAgentContextReader,
  gitHubProviderDefinition,
  resolveGitHubResourceUrl,
} from '../integrations/github/index.js';
import { WorkStatus, createWorkService, type WorkItemView } from '../work/index.js';
import { loadConfig, type ResolvedWakeModulesConfig } from './config/load-config.js';
import { hydrateFakeProviderEvidence } from './fake-provider-files.js';
import { loadFakeScenarios } from './fake-scenarios.js';
import { resolveWakePaths, type WakePaths } from './paths.js';
import { createRuntimeProjectionRunner } from './projection-runtime.js';
import { createRunnerQuotaReporter } from './runner-quota-reporter.js';
import { createRunnerRegistry } from './runner-registry.js';
import { FileScheduleCheckpointStore } from './schedule-checkpoint-store.js';
import { createStatusPublishActivity } from './status-publish-activity.js';
import {
  createUpdateMaintenanceLease,
  type UpdateMaintenanceLease,
} from './update-maintenance-lease.js';

export interface CompositionRootOptions {
  readonly config?: ResolvedWakeModulesConfig;
  readonly journal?: EventJournal;
  readonly projections?: ProjectionStore;
  readonly checkpoints?: CheckpointStore;
  readonly activities?: ActivityRegistry;
  readonly clock?: Clock;
  readonly transcriptStore?: TranscriptStore;
  /**
   * Optional integration-boundary decorators. They are applied once, before
   * any composed service receives the port, so observability and fault
   * injection can exercise the real production topology without domain hooks.
   */
  readonly decorateJournal?: (journal: EventJournal) => EventJournal;
  readonly decorateProjections?: (projections: ProjectionStore) => ProjectionStore;
  readonly decorateCheckpoints?: (checkpoints: CheckpointStore) => CheckpointStore;
  readonly scheduleCheckpoints?: ScheduleCheckpointStore;
  readonly decorateDeliveryAdapter?: (
    adapter: ExternalDeliveryAdapter,
    provider: ProviderInstance,
  ) => ExternalDeliveryAdapter;
  readonly decorateRunner?: (runner: Runner, name: string) => Runner;
  /** A real fake-provider adapter for deterministic composed integration evidence. */
  readonly fakeDeliveryProvider?: DurableFakeDeliveryProvider;
}

export interface CompositionRoot {
  readonly config: ResolvedWakeModulesConfig;
  readonly fakeScenarios: FakeScenarioResolver;
  readonly paths: WakePaths;
  readonly maintenance: UpdateMaintenanceLease;
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
  readonly activities: ActivityRegistry;
  readonly work: ReturnType<typeof createWorkService>;
  readonly resources: ReturnType<typeof createResourceService>;
  readonly lookup: ReturnType<typeof createResourceLookup>;
  readonly orchestration: ReturnType<typeof createOrchestrationService>;
  readonly execution: ReturnType<typeof createExecutionService>;
  readonly transcriptStore?: TranscriptStore;
  readonly runnerControls: ReturnType<typeof createRunnerControlService>;
  readonly controlPlane: ReturnType<typeof createControlPlaneService>;
  /** Shared operator-or-maintenance pause supplier for every resident runtime loop. */
  readonly isPaused: () => Promise<boolean>;
  readonly advanceOnce: ReturnType<typeof createAdvanceOnce>;
  readonly projectionRunner: ReturnType<typeof createRuntimeProjectionRunner>;
  readonly providers: readonly ProviderInstance[];
  readonly providerFailures: readonly ProviderCompositionFailure[];
  readonly delivery: DeliveryService;
  readonly intakePipeline: IntakePipeline;
  readonly runnerPipeline: RunnerPipeline;
  readonly resolveResourceLink: ResourceLinkResolver;
}

const resourceLinkResolvers: Record<string, ResourceLinkResolver> = {
  github: resolveGitHubResourceUrl,
};

function resolveResourceLink(externalKey: {
  readonly adapter: string;
  readonly key: string;
}): string | null {
  return resourceLinkResolvers[externalKey.adapter]?.(externalKey) ?? null;
}

// Composition is deliberately the one place that assembles every module.
// eslint-disable-next-line complexity
export async function createCompositionRoot(
  wakeRoot: string,
  options: CompositionRootOptions = {},
): Promise<CompositionRoot> {
  const config = options.config ?? (await loadConfig(wakeRoot));
  const fakeScenarios = await loadFakeScenarios(wakeRoot);
  const paths = resolveWakePaths(wakeRoot);
  const maintenance = createUpdateMaintenanceLease(paths.wakeRoot);
  const clock = options.clock ?? new SystemClock();
  const ids = new UlidIdGenerator();
  const { journal, projections, checkpoints } = composePersistence(paths, clock, options);
  const work = createWorkService(journal);
  const lookup = createResourceLookup({ journal, projections });
  const resources = createResourceService(journal, lookup);
  const pullRequests = createPullRequestService(journal, work, resources);
  const activities =
    options.activities ?? createBuiltInActivityRegistry(journal, pullRequests, resources, wakeRoot);
  const definitions = Object.fromEntries(
    Object.entries(config.orchestration.workflows).map(([name, definition]) => [
      name,
      compileWorkflow(name, definition, activities, Object.keys(config.orchestration.workflows)),
    ]),
  );
  const orchestration = createOrchestrationService(journal, work, definitions, projections);
  const workspaces = new GitWorkspaceProvider(paths.workspacesRoot, {
    async cloneLocator(id) {
      const resource = await resources.get(resourceId(id));
      const match =
        resource === null ? null : /^([^/]+\/[^#]+)#\d+$/.exec(resource.externalKey.key);
      if (match === null)
        throw new Error('Workspace resource ' + id + ' does not identify a GitHub repository');
      return 'https://github.com/' + match[1] + '.git';
    },
  });
  const transcriptStore = config.transcripts.enabled
    ? (options.transcriptStore ?? new TranscriptStore(paths.transcriptsRoot))
    : undefined;
  const execution = createExecutionService(journal, activities, config.execution, {
    clock,
    ids,
    runners: createRunnerRegistry(config.execution, fakeScenarios, options.decorateRunner),
    reportRunnerQuota: createRunnerQuotaReporter(journal, clock, ids),
    ...(transcriptStore !== undefined
      ? {
          transcriptRecorder: transcriptStore,
          logOperationalError(error) {
            console.error('Transcript capture failed', error);
          },
        }
      : {}),
    workspaces,
  });
  const recovery = new RecoveryService(
    journal,
    clock,
    {
      async inspect() {
        // Runner adapters do not yet expose a portable process-inspection API.
        // Preserve safety on restart: unknown external work is reconciled through
        // the existing ambiguity path rather than being guessed as absent.
        return {
          kind: ExternalExecutionState.Unknown,
          reason: 'External execution inspection is not configured for this runtime',
        };
      },
    },
    activities,
    config.execution,
    orchestration,
  );
  const controlPlane = createControlPlaneService({ journal, clock, ids });
  const isRuntimePaused = async () =>
    (await controlPlane.isPaused()) || (await maintenanceBlocksRuntime(maintenance));
  const runnerControls = createRunnerControlService({
    journal,
    clock,
    ids,
    runners: new Set(Object.values(config.execution.runnerPools).flat()),
  });
  const advanceOnce = createAdvanceOnce(
    orchestration,
    {
      ...execution,
      recoverActive: (owner) => recovery.recoverActive(owner, execution.isLocallyActive),
    },
    resources,
    clock,
    {
      ids,
      dispatchPolicy: new DispatchPolicy({ maxDispatches: config.controlPlane.maxDispatches }),
      isDispatchPaused: isRuntimePaused,
      workspaceRecovery: workspaces,
      work,
      ...(transcriptStore === undefined
        ? {}
        : {
            transcriptRetention: {
              async markClosedWorkItem(workItemId) {
                try {
                  await transcriptStore.markWorkItemCleaned(
                    workItemId,
                    config.transcripts.retentionMs,
                    clock.now().toISOString(),
                  );
                  return true;
                } catch (error) {
                  console.error('Transcript retention failed', error);
                  return false;
                }
              },
              async sweep() {
                try {
                  await transcriptStore.sweepExpired(
                    config.transcripts.retentionMs,
                    clock.now().toISOString(),
                    (_workItemId, error) => console.error('Transcript retention failed', error),
                  );
                } catch (error) {
                  console.error('Transcript retention failed', error);
                }
              },
            },
            closedWorkItemIds: () => closedWorkItemIds(projections),
          }),
      runnerIneligibility: async () => {
        const stored = await projections.read<ControlPlaneView>(ControlStreamKind.Global, 'global');
        return stored === null
          ? new Set()
          : ineligibleRunners(stored.value, clock.now().toISOString());
      },
    },
  );
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
    ...(transcriptStore === undefined ? {} : { transcriptStore }),
    advanceOnce,
    controlPlane,
    isPaused: isRuntimePaused,
    clock,
    work,
    ids,
    wakeRoot,
    scheduleCheckpoints:
      options.scheduleCheckpoints ?? new FileScheduleCheckpointStore(paths.dataRoot),
    ...(options.decorateDeliveryAdapter === undefined
      ? {}
      : { decorateDeliveryAdapter: options.decorateDeliveryAdapter }),
    ...(options.fakeDeliveryProvider === undefined
      ? {}
      : { fakeDeliveryProvider: options.fakeDeliveryProvider }),
  });
  return {
    config,
    fakeScenarios,
    paths,
    maintenance,
    journal,
    projections,
    checkpoints,
    activities,
    work,
    resources,
    lookup,
    orchestration,
    execution,
    ...(transcriptStore === undefined ? {} : { transcriptStore }),
    runnerControls,
    controlPlane,
    isPaused: isRuntimePaused,
    advanceOnce,
    resolveResourceLink,
    ...runtime,
  };
}

async function maintenanceBlocksRuntime(maintenance: UpdateMaintenanceLease): Promise<boolean> {
  return (await maintenance.read()) !== null;
}

async function closedWorkItemIds(projections: ProjectionStore): Promise<readonly string[]> {
  return (await projections.list<WorkItemView | null>('work')).flatMap(({ value }) =>
    value?.state === WorkStatus.Closed ? [value.workItemId] : [],
  );
}

interface IntegrationRuntime {
  readonly projectionRunner: ReturnType<typeof createRuntimeProjectionRunner>;
  readonly providers: readonly ProviderInstance[];
  readonly providerFailures: readonly ProviderCompositionFailure[];
  readonly delivery: DeliveryService;
  readonly intakePipeline: IntakePipeline;
  readonly runnerPipeline: RunnerPipeline;
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

async function composeIntegrationRuntime(
  input: IntegrationRuntimeInput,
): Promise<IntegrationRuntime> {
  const registry = new ProviderRegistry();
  registry.register(fakeProviderDefinition);
  registry.register(gitHubProviderDefinition);
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
  input.orchestration.setPreAcceptSignalBarrier(() => resourceTransitions.runOnce());
  const outcomes = new DeliveryOutcomeReactor(
    input.journal,
    input.checkpoints,
    input.orchestration,
  );
  const catchUpProjections = async () => {
    await projectionRunner.runRegisteredOnce();
  };
  // Only poll hits a rate-limited external API, so only this half of the
  // tick needs a backing-off host — see bootstrap/surface-cli-applications.ts.
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

function identity<T>(value: T): T {
  return value;
}

function composePersistence(
  paths: WakePaths,
  clock: Clock,
  options: CompositionRootOptions,
): Pick<CompositionRoot, 'journal' | 'projections' | 'checkpoints'> {
  return {
    journal: (options.decorateJournal ?? identity)(
      options.journal ?? new FileEventJournal(paths.dataRoot, clock),
    ),
    projections: (options.decorateProjections ?? identity)(
      options.projections ?? new FileProjectionStore(paths.dataRoot),
    ),
    checkpoints: (options.decorateCheckpoints ?? identity)(
      options.checkpoints ?? new FileCheckpointStore(paths.dataRoot),
    ),
  };
}

function createBuiltInActivityRegistry(
  journal: EventJournal,
  pullRequests: ReturnType<typeof createPullRequestService>,
  resources: ReturnType<typeof createResourceService>,
  wakeRoot: string,
): ActivityRegistry {
  const activities = new ActivityRegistry();
  const contextReader = createGitHubAgentContextReader(journal, resources);
  activities.register({
    ...agentActivityDefinition,
    handler: createAgentActivity(
      {
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
      },
      contextReader,
    ),
  });
  activities.register(createStatusPublishActivity(journal));
  activities.register(createIssueCompleteActivity(journal, resources));
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
