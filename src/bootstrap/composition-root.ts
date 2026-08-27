import { createPullRequestService, type ActivityRegistry } from '../activities/index.js';
import {
  ControlStreamKind,
  DispatchPolicy,
  createAdvanceOnce,
  createControlPlaneService,
  createRunnerControlService,
  ineligibleRunners,
  type ControlPlaneView,
  type IntakePipeline,
  type RunnerPipeline,
  type ScheduleCheckpointStore,
} from '../control-plane/index.js';
import { createConversationService } from '../conversations/index.js';
import {
  ExecutionCancellationReason,
  ExternalExecutionState,
  GitWorkspaceProvider,
  RecoveryService,
  TranscriptStore,
  createExecutionService,
  createRunnerMemoryProfileDecorator,
  type FakeScenarioResolver,
  type Runner,
} from '../execution/index.js';
import {
  createGitHubAgentContextReader,
  gitHubProviderDefinition,
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
  SystemClock,
  UlidIdGenerator,
  type CheckpointStore,
  type Clock,
  type EventJournal,
  type ProjectionStore,
} from '../kernel/index.js';
import { compileWorkflow, createOrchestrationService } from '../orchestration/index.js';
import {
  createResourceLookup,
  createResourceService,
  resourceId,
  type ResourceLinkResolver,
} from '../resources/index.js';
import { createWorkService } from '../work/index.js';
import { createBuiltInActivityRegistry } from './activity-registry.js';
import { loadConfig, type ResolvedWakeModulesConfig } from './config/load-config.js';
import { loadFakeScenarios } from './fake-scenarios.js';
import { composeIntegrationRuntime } from './integration-runtime.js';
import { resolveWakePaths, type WakePaths } from './paths.js';
import { composePersistence } from './persistence-composition.js';
import {
  createFileProjectionRunSerialiser,
  type createRuntimeProjectionRunner,
} from './projection-runtime.js';
import { createRunnerQuotaReporter } from './runner-quota-reporter.js';
import { createRunnerRegistry } from './runner-registry.js';
import { FileScheduleCheckpointStore } from './schedule-checkpoint-store.js';
import { createTranscriptRetention } from './transcript-retention.js';
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
  readonly conversations: ReturnType<typeof createConversationService>;
  readonly resources: ReturnType<typeof createResourceService>;
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

function resolveResourceLink(externalKey: Parameters<ResourceLinkResolver>[0]): string | null {
  return resourceLinkResolvers[externalKey.adapter]?.(externalKey) ?? null;
}

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
      createGitHubAgentContextReader(journal, resources, {
        publicUiUrl: config.surfaces.web.publicUrl,
        githubAdapters: githubAdapters(config),
      }),
    );
  const definitions = Object.fromEntries(
    Object.entries(config.orchestration.workflows).map(([name, definition]) => [
      name,
      compileWorkflow(name, definition, activities, Object.keys(config.orchestration.workflows)),
    ]),
  );
  const orchestration = createOrchestrationService(journal, work, definitions, projections);
  const workspaces = new GitWorkspaceProvider(
    paths.workspacesRoot,
    {
      async cloneLocator(id) {
        const resource = await resources.get(resourceId(id));
        const match =
          resource === null ? null : /^([^/]+\/[^#]+)#\d+$/.exec(resource.externalKey.key);
        if (match === null)
          throw new Error('Workspace resource ' + id + ' does not identify a GitHub repository');
        return 'https://github.com/' + match[1] + '.git';
      },
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
  const execution = createExecutionService(journal, activities, config.execution, {
    clock,
    ids,
    runners: createRunnerRegistry(config.execution, fakeScenarios, decorateRunner),
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
    {
      async inspect() {
        // Unknown external work follows the safe ambiguity path until runners expose inspection.
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
    (await controlPlane.isPaused()) || (await maintenance.read()) !== null;
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
      maxConcurrentRuns: config.controlPlane.maxConcurrentRuns,
      maxDispatches: config.controlPlane.maxDispatches,
      isDispatchPaused: isRuntimePaused,
      workspaceRecovery: workspaces,
      work,
      ...(transcriptStore === undefined
        ? {}
        : createTranscriptRetention(transcriptStore, projections, config, clock)),
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
    projectionRunSerialiser: createFileProjectionRunSerialiser(paths.dataRoot),
    scheduleCheckpoints:
      options.scheduleCheckpoints ?? new FileScheduleCheckpointStore(paths.dataRoot),
    ...(options.decorateDeliveryAdapter === undefined
      ? {}
      : { decorateDeliveryAdapter: options.decorateDeliveryAdapter }),
    ...(options.fakeDeliveryProvider === undefined
      ? {}
      : { fakeDeliveryProvider: options.fakeDeliveryProvider }),
    providerDefinitions: [gitHubProviderDefinition],
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
    conversations,
    resources,
    lookup,
    orchestration,
    execution,
    recovery,
    ...(transcriptStore === undefined ? {} : { transcriptStore }),
    runnerControls,
    controlPlane,
    isPaused: isRuntimePaused,
    advanceOnce,
    resolveResourceLink,
    ...runtime,
  };
}

function githubAdapters(config: ResolvedWakeModulesConfig): readonly string[] {
  return Object.entries(config.integrations).flatMap(([adapter, integration]) =>
    integration.enabled && (integration.provider ?? adapter) === 'github' ? [adapter] : [],
  );
}
