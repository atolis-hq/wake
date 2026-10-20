import {
  type CheckpointStore,
  type EventJournal,
  type ProcessorRunSerialiser,
  type ProcessorStateStore,
  type ProjectionStore,
} from '@atolis-hq/eventing';
import { acquireFileLock } from '@atolis-hq/eventing-filesystem';
import { createPullRequestService, type ActivityRegistry } from '../activities/index.js';
import {
  ArtifactContextService,
  FileArtifactMcpSessionStore,
  FileArtifactStore,
  OperatorInstructionsService,
  createArtifactService,
  createDelegationArtifacts,
} from '../artifacts/index.js';
import {
  DispatchPolicy,
  createActivationScheduler,
  createActivationSchedulerSubscriber,
  createControlPlaneService,
  createDurableRunnerIneligibility,
  createRunnerControlService,
  type ActivationScheduler,
  type ActivationSchedulerSubscriber,
  type IntakePipeline,
  type RunnerPipeline,
  type TriggerCheckpointStore,
  type TriggerConfig,
  type TriggerService,
} from '../control-plane/index.js';
import { createConversationService } from '../conversations/index.js';
import {
  ExecutionCancellationReason,
  GitWorkspaceProvider,
  RecoveryService,
  RunStatus,
  TranscriptStore,
  createExecutionService,
  createLocalProcessInspector,
  createRepositoryAssignments,
  createRunnerMemoryProfileDecorator,
  isActiveRunStatus,
  resolveGitSource,
  type FakeScenarioResolver,
  type RepositoryCloneResolver,
  type Runner,
} from '../execution/index.js';
import {
  createGitHubAgentContextReader,
  gitHubProviderDefinition,
  gitHubRepositoryIdentity,
  resolveGitHubResourceUrl,
} from '../integrations/github/index.js';
import type {
  DeliveryService,
  DurableFakeDeliveryProvider,
  ExternalDeliveryAdapter,
  ProviderCompositionFailure,
  ProviderInstance,
} from '../integrations/index.js';
import {
  createDelegationOutputs,
  createDeliveryIntegrationVerification,
} from '../integrations/index.js';
import { SystemClock, UlidIdGenerator, type Clock } from '../kernel/index.js';
import {
  DelegationOutputKind,
  compileWorkflow,
  createAgentActivityClassifier,
  createOrchestrationService,
} from '../orchestration/index.js';
import {
  createResourceLookup,
  createResourceService,
  resourceId,
  type ResourceLinkResolver,
} from '../resources/index.js';
import { createWorkService } from '../work/index.js';
import { createFileActivationSchedulerSerialiser } from './activation-scheduler-serialiser.js';
import { createBuiltInActivityRegistry } from './activity-registry.js';
import { createArtifactMcpProvisioner } from './artifact-mcp.js';
import { createArtifactTriggerContext } from './artifact-trigger-context.js';
import { loadConfig, type ResolvedWakeModulesConfig } from './config/load-config.js';
import { createDelegationAuthority } from './delegation-authority.js';
import { createDeliveryIntegration } from './delivery-integration.js';
import { EventProcessorRuntime } from './event-processor-runtime.js';
import { loadFakeScenarios } from './fake-scenarios.js';
import { composeIntegrationRuntime, composeProviders } from './integration-runtime.js';
import { resolveWakePaths, type WakePaths } from './paths.js';
import { composePersistence } from './persistence-composition.js';
import type { RuntimeProjectionSubscriptions } from './projection-runtime.js';
import { createRunnerQuotaReporter } from './runner-quota-reporter.js';
import { createRunnerRegistry } from './runner-registry.js';
import { createTranscriptRetention } from './transcript-retention.js';
import { ProcessorTriggerCheckpointStore } from './trigger-checkpoint-store.js';
import {
  createUpdateMaintenanceLease,
  type UpdateMaintenanceLease,
} from './update-maintenance-lease.js';

export interface CompositionRootOptions {
  readonly config?: ResolvedWakeModulesConfig;
  readonly journal?: EventJournal;
  readonly projections?: ProjectionStore;
  readonly checkpoints?: CheckpointStore;
  readonly processorState?: ProcessorStateStore;
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
  readonly subscriptionRunSerialiser?: ProcessorRunSerialiser;
  readonly triggerCheckpoints?: TriggerCheckpointStore;
  /** Trusted context binding supplies a shared scope identity; absent bindings use the trigger ID. */
  readonly triggerCoordinationKey?: (config: TriggerConfig) => string;
  readonly decorateDeliveryAdapter?: (
    adapter: ExternalDeliveryAdapter,
    provider: ProviderInstance,
  ) => ExternalDeliveryAdapter;
  readonly decorateRepositoryCloneResolver?: (
    resolver: RepositoryCloneResolver,
  ) => RepositoryCloneResolver;
  readonly decorateRunner?: (runner: Runner, name: string) => Runner;
  /** A real fake-provider adapter for deterministic composed integration evidence. */
  readonly fakeDeliveryProvider?: DurableFakeDeliveryProvider;
}

export interface CompositionRoot {
  readonly workflowNotices: readonly string[];
  readonly triggers: TriggerService;
  readonly config: ResolvedWakeModulesConfig;
  readonly fakeScenarios: FakeScenarioResolver;
  readonly paths: WakePaths;
  readonly maintenance: UpdateMaintenanceLease;
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
  readonly processorState: ProcessorStateStore;
  readonly activities: ActivityRegistry;
  readonly work: ReturnType<typeof createWorkService>;
  readonly artifacts: ReturnType<typeof createArtifactService>;
  readonly operatorInstructions: OperatorInstructionsService;
  readonly conversations: ReturnType<typeof createConversationService>;
  readonly resources: ReturnType<typeof createResourceService>;
  readonly pullRequests: ReturnType<typeof createPullRequestService>;
  readonly lookup: ReturnType<typeof createResourceLookup>;
  readonly orchestration: ReturnType<typeof createOrchestrationService>;
  readonly execution: ReturnType<typeof createExecutionService>;
  /** Operator-only resolution of a durably escalated ambiguous Run. */
  readonly recovery: RecoveryService;
  readonly transcriptStore?: TranscriptStore;
  readonly runnerControls: ReturnType<typeof createRunnerControlService>;
  readonly controlPlane: ReturnType<typeof createControlPlaneService>;
  /** Shared operator-or-maintenance pause supplier for every resident runtime loop. */
  readonly isPaused: () => Promise<boolean>;
  readonly activationScheduler: ActivationScheduler;
  readonly activationSchedulerSubscriber: ActivationSchedulerSubscriber;
  readonly processorRuntime: EventProcessorRuntime;
  readonly advanceOnce: ActivationScheduler['runOnce'];
  readonly projectionSubscriptions: RuntimeProjectionSubscriptions;
  readonly providers: readonly ProviderInstance[];
  readonly providerFailures: readonly ProviderCompositionFailure[];
  readonly delivery: DeliveryService;
  readonly intakePipeline: IntakePipeline;
  readonly runnerPipeline: RunnerPipeline;
  readonly requestImmediatePoll: (adapter: string) => void;
  readonly resolveResourceLink: ResourceLinkResolver;
  readonly resolveResourceRepositoryIdentity: (
    externalKey: Parameters<ResourceLinkResolver>[0],
  ) => string | undefined;
}

export function resolveResourceRepositoryIdentity(
  externalKey: Parameters<ResourceLinkResolver>[0],
): string | undefined {
  return externalKey.adapter === 'github' ? gitHubRepositoryIdentity(externalKey.key) : undefined;
}

const resourceLinkResolvers: Record<string, ResourceLinkResolver> = {
  github: resolveGitHubResourceUrl,
};

function resolveResourceLink(externalKey: Parameters<ResourceLinkResolver>[0]): string | null {
  return resourceLinkResolvers[externalKey.adapter]?.(externalKey) ?? null;
}

async function createApplicationServices(wakeRoot: string, options: CompositionRootOptions = {}) {
  const config = options.config ?? (await loadConfig(wakeRoot));
  const fakeScenarios = await loadFakeScenarios(wakeRoot);
  const paths = resolveWakePaths(wakeRoot);
  const maintenance = createUpdateMaintenanceLease(paths.wakeRoot);
  const clock = options.clock ?? new SystemClock();
  const ids = new UlidIdGenerator();
  const { journal, projections, checkpoints, processorState, subscriptionRunSerialiser } =
    composePersistence(paths, clock, options);
  const work = createWorkService(journal);
  const artifacts = createArtifactService(
    journal,
    new FileArtifactStore(paths.artifactsRoot),
    config.artifacts,
  );
  const artifactContexts = new ArtifactContextService(journal, artifacts);
  const operatorInstructions = new OperatorInstructionsService(
    journal,
    new FileArtifactStore(paths.artifactsRoot),
    config.artifacts,
  );
  const artifactMcpSessions = new FileArtifactMcpSessionStore(paths.artifactsRoot, () =>
    clock.now().toISOString(),
  );
  const conversations = createConversationService(journal);
  const lookup = createResourceLookup({ journal, projections });
  const resources = createResourceService(journal, lookup);
  const pullRequests = createPullRequestService(journal, work, resources);
  const activities =
    options.activities ??
    createBuiltInActivityRegistry(
      journal,
      pullRequests,
      resources,
      wakeRoot,
      createGitHubAgentContextReader(
        journal,
        resources,
        {
          publicUiUrl: config.surfaces.web.publicUrl,
          githubAdapters: githubAdapters(config),
        },
        conversations,
      ),
      // Resolved lazily: Orchestration is composed after the registry it compiles against.
      { authorize: (request) => orchestration.authorizeParentAction(request) },
    );
  const workflowNotices: string[] = [];
  const definitions = Object.fromEntries(
    Object.entries(config.orchestration.workflows).map(([name, definition]) => [
      name,
      compileWorkflow(
        name,
        definition,
        activities,
        Object.keys(config.orchestration.workflows),
        (diagnostic) => {
          workflowNotices.push(diagnostic.message);
          process.stderr.write(`Warning: ${diagnostic.message}\n`);
        },
      ),
    ]),
  );
  const providerInstances = createProviderBinding();
  const cloneResolver = createCloneResolver(resources, options);
  const orchestration = createOrchestrationService(
    journal,
    work,
    definitions,
    projections,
    createAgentActivityClassifier(activities),
    (queries) => ({
      authority: createDelegationAuthority(journal, resources, activities, {
        ids,
        repositoryIdentity: resolveResourceRepositoryIdentity,
      }),
      repositories: createRepositoryAssignments(
        resources,
        (request) => resolveGitSource(cloneResolver, request),
        (id) => orchestration.repositoryAssignment(id),
        (id) => orchestration.repositoryAuthority(id),
      ),
      artifacts: createDelegationOutputs({
        providers: () => providerInstances.promise,
        resources,
        pullRequests,
        runs: () => execution.list(),
        artifacts: createDelegationArtifacts({
          artifacts,
          contexts: artifactContexts,
          accepted: queries.isActivationAccepted,
        }),
      }),
      integration: createDeliveryIntegration(
        pullRequests,
        () => execution.list(),
        createDeliveryIntegrationVerification({
          runs: () => execution.list(),
          resources,
          pullRequests,
          providers: () => providerInstances.promise,
        }),
      ),
      runHasEnded: async (runId) => {
        const run = (await execution.list()).find((entry) => entry.runId === runId);
        return (
          run !== undefined &&
          !isActiveRunStatus(run.status) &&
          run.status !== RunStatus.Ambiguous &&
          !execution.isLocallyActive(runId)
        );
      },
    }),
  );
  const workspaces = new GitWorkspaceProvider(
    paths.workspacesRoot,
    cloneResolver,
    {
      tryAcquire: (path) =>
        acquireFileLock(path, {
          staleAfterMs: 0,
          staleRequiresDeadProcess: true,
        }),
    },
    undefined,
    undefined,
    config.execution.workspaceHooks?.prepare,
  );
  const transcriptStore = config.transcripts.enabled
    ? (options.transcriptStore ?? new TranscriptStore(paths.transcriptsRoot))
    : undefined;
  const profileDecorator =
    process.env.WAKE_MEMORY_PROFILE === 'runner'
      ? createRunnerMemoryProfileDecorator({
          write: (line) => process.stderr.write(line),
          now: () => clock.now().toISOString(),
          memoryUsage: () => process.memoryUsage(),
        })
      : undefined;
  const decorateRunner =
    profileDecorator === undefined
      ? options.decorateRunner
      : options.decorateRunner === undefined
        ? profileDecorator
        : (runner: Runner, name: string) =>
            profileDecorator(options.decorateRunner!(runner, name), name);
  const runners = createRunnerRegistry(config.execution, fakeScenarios, decorateRunner);
  const artifactTriggerContext = createArtifactTriggerContext({
    journal,
    contexts: artifactContexts,
    artifacts,
    orchestration,
    triggers: config.controlPlane.triggers,
    now: () => clock.now().toISOString(),
  });
  const execution = createExecutionService(journal, activities, config.execution, {
    clock,
    ids,
    runners,
    mcp: createArtifactMcpProvisioner({
      artifacts,
      orchestration,
      sessions: artifactMcpSessions,
      wakeRoot: paths.wakeRoot,
      now: () => clock.now().toISOString(),
      nextId: () => ids.next(DelegationOutputKind.Artifact),
      sharedContext: artifactTriggerContext.provision,
      operatorInstructions,
      journal,
    }),
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
  orchestration.setWatchChildCancellation({
    cancelSupersededWatchChildren: (workflowInstanceIds) =>
      execution.cancelActive(workflowInstanceIds, ExecutionCancellationReason.WorkflowSuperseded),
  });
  const recovery = new RecoveryService(
    journal,
    clock,
    createLocalProcessInspector(),
    activities,
    config.execution,
    orchestration,
  );
  const controlPlane = createControlPlaneService({ journal, clock, ids });
  const isRuntimePaused = async () =>
    (await controlPlane.isDispatchPaused()) || (await maintenance.read()) !== null;
  const runnerControls = createRunnerControlService({
    journal,
    clock,
    ids,
    runners: new Set(Object.values(config.execution.runnerPools).flat()),
  });
  return {
    providerInstances,
    config,
    fakeScenarios,
    workflowNotices,
    paths,
    maintenance,
    clock,
    ids,
    journal,
    projections,
    checkpoints,
    processorState,
    subscriptionRunSerialiser,
    work,
    artifacts,
    operatorInstructions,
    conversations,
    resources,
    pullRequests,
    lookup,
    orchestration,
    execution,
    recovery,
    transcriptStore,
    runnerControls,
    controlPlane,
    isRuntimePaused,
    activities,
    runners,
    artifactTriggerContext,
    workspaces,
  };
}

export async function createDiagnosticRoot(wakeRoot: string) {
  const base = await createApplicationServices(wakeRoot);
  const { instances, failures } = await composeProviders({
    ...base,
    wakeRoot,
    providerDefinitions: [gitHubProviderDefinition],
  });
  base.providerInstances.resolve(instances);
  return { ...base, providers: instances, providerFailures: failures };
}

export async function createCompositionRoot(
  wakeRoot: string,
  options: CompositionRootOptions = {},
): Promise<CompositionRoot> {
  const {
    providerInstances,
    config,
    fakeScenarios,
    workflowNotices,
    paths,
    maintenance,
    clock,
    ids,
    journal,
    projections,
    checkpoints,
    processorState,
    subscriptionRunSerialiser,
    work,
    artifacts,
    operatorInstructions,
    conversations,
    resources,
    pullRequests,
    lookup,
    orchestration,
    execution,
    recovery,
    transcriptStore,
    runnerControls,
    controlPlane,
    isRuntimePaused,
    activities,
    runners,
    artifactTriggerContext,
    workspaces,
  } = await createApplicationServices(wakeRoot, options);
  const processorRuntime = new EventProcessorRuntime(
    journal,
    checkpoints,
    subscriptionRunSerialiser,
    clock,
  );
  const activationScheduler = createActivationScheduler(
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
      maxConcurrentRuns: config.controlPlane.maxConcurrentRuns,
      maxOpenWorkItems: config.controlPlane.maxOpenWorkItems ?? null,
      maxDispatches: config.controlPlane.maxDispatches,
      schedulerSerialiser: createFileActivationSchedulerSerialiser(paths.dataRoot),
      isDispatchPaused: isRuntimePaused,
      workspaceRecovery: workspaces,
      work,
      ...(transcriptStore === undefined
        ? {}
        : createTranscriptRetention(transcriptStore, projections, config, clock)),
      runnerIneligibility: createDurableRunnerIneligibility(journal, () =>
        clock.now().toISOString(),
      ),
    },
  );
  const advanceOnce = Object.assign(activationScheduler.runOnce.bind(activationScheduler), {
    maintain: activationScheduler.maintain!.bind(activationScheduler),
    dispatch: activationScheduler.dispatch!.bind(activationScheduler),
  });
  const activationSchedulerSubscriber = createActivationSchedulerSubscriber(activationScheduler);
  const runtime = await composeIntegrationRuntime({
    config,
    journal,
    projections,
    checkpoints,
    processorState,
    resources,
    lookup,
    pullRequests,
    orchestration,
    execution,
    ...(transcriptStore === undefined ? {} : { transcriptStore }),
    controlPlane,
    isPaused: isRuntimePaused,
    clock,
    work,
    conversations,
    ids,
    wakeRoot,
    subscriptionRunSerialiser,
    processorRuntime,
    activities,
    runners,
    reconcileArtifactContext: artifactTriggerContext.reconcile,
    triggerCheckpoints:
      options.triggerCheckpoints ?? new ProcessorTriggerCheckpointStore(processorState),
    ...(options.triggerCoordinationKey === undefined
      ? {}
      : { triggerCoordinationKey: options.triggerCoordinationKey }),
    ...(options.decorateDeliveryAdapter === undefined
      ? {}
      : { decorateDeliveryAdapter: options.decorateDeliveryAdapter }),
    ...(options.fakeDeliveryProvider === undefined
      ? {}
      : { fakeDeliveryProvider: options.fakeDeliveryProvider }),
    providerDefinitions: [gitHubProviderDefinition],
  });
  providerInstances.resolve(runtime.providers);
  processorRuntime.register([activationSchedulerSubscriber.processor, ...runtime.processors]);
  return {
    workflowNotices,
    config,
    fakeScenarios,
    paths,
    maintenance,
    journal,
    projections,
    checkpoints,
    processorState,
    activities,
    work,
    artifacts,
    operatorInstructions,
    conversations,
    resources,
    pullRequests,
    lookup,
    orchestration,
    execution,
    recovery,
    ...(transcriptStore === undefined ? {} : { transcriptStore }),
    runnerControls,
    controlPlane,
    isPaused: isRuntimePaused,
    activationScheduler,
    activationSchedulerSubscriber,
    processorRuntime,
    advanceOnce,
    resolveResourceLink,
    resolveResourceRepositoryIdentity,
    ...runtime,
  };
}

function githubAdapters(config: ResolvedWakeModulesConfig): readonly string[] {
  return Object.entries(config.integrations).flatMap(([adapter, integration]) =>
    integration.enabled && (integration.provider ?? adapter) === 'github' ? [adapter] : [],
  );
}

function createCloneResolver(
  resources: ReturnType<typeof createResourceService>,
  options: CompositionRootOptions,
): RepositoryCloneResolver {
  const defaultCloneResolver: RepositoryCloneResolver = {
    async cloneLocator(id: string) {
      const resource = await resources.get(resourceId(id));
      // Repository, PR and issue keys resolve to one clone; the '#N' suffix is optional.
      const repository = resource?.externalKey.key.replace(/#\d+$/, '');
      if (repository === undefined || !/^[^/]+\/[^/#]+$/.test(repository))
        throw new Error('Workspace resource ' + id + ' does not identify a GitHub repository');
      return 'https://github.com/' + repository + '.git';
    },
  };
  return options.decorateRepositoryCloneResolver?.(defaultCloneResolver) ?? defaultCloneResolver;
}

function createProviderBinding() {
  let bind!: (providers: readonly ProviderInstance[]) => void;
  const promise = new Promise<readonly ProviderInstance[]>((resolve) => {
    bind = resolve;
  });
  return { promise, resolve: bind };
}
