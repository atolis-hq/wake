import { RunStatus, WorkspaceMode } from '../contracts/vocabulary.js';
import { EventActorKind, EventSourceKind } from '../../kernel/index.js';
import {
  type ActivityExecutionContext,
  ActivityExecutionKind,
  type ActivityRegistry,
  type ResourceRequirement,
} from '../../activities/index.js';
import {
  createEventDraft,
  type Clock,
  type EventJournal,
  type IdGenerator,
} from '../../kernel/index.js';
import type { ResourceView } from '../../resources/index.js';
import type { ExecutionConfig } from '../contracts/config.js';
import type { ExecutionActivation, ExecutionAttemptContext } from '../contracts/commands.js';
import { ExecutionEventType, type RunExecutionEventPayloads } from '../contracts/events.js';
import { runId } from '../contracts/identifiers.js';
import { ExecutionStreamKind, runStream } from '../contracts/streams.js';
import type { WorkspaceLease, WorkspaceProvider } from '../contracts/workspace.js';
import { failureFrom } from '../domain/run-result.js';
import { RunRepository } from './run-repository.js';
import { acquireWorkspace, validateResourceRequirements } from './execution-validation.js';
import {
  claimRun,
  confirmCancellation,
  renewLease,
  requestCancellation,
} from './run-liveness-service.js';
import { claimActivation, releaseActivation } from './activation-claim.js';
import { cancelActiveRuns } from './active-run-cancellation.js';
import { RunnerRegistry } from '../infrastructure/runners/registry.js';

export interface ExecutionDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly workspaces?: WorkspaceProvider;
  readonly runners?: RunnerRegistry;
}

interface ExecutionRuntime {
  readonly activities: ActivityRegistry;
  readonly config: ExecutionConfig;
  readonly dependencies: ExecutionDependencies;
  readonly repository: RunRepository;
  readonly active: Map<string, AbortController>;
  readonly journal: EventJournal;
}

export function createExecutionService(
  journal: EventJournal,
  activities: ActivityRegistry,
  config: ExecutionConfig,
  dependencies: ExecutionDependencies,
) {
  const repository = new RunRepository(journal);
  const active = new Map<string, AbortController>();
  return {
    attempt: (activation: ExecutionActivation, context: ExecutionAttemptContext) =>
      attemptExecution(
        { activities, config, dependencies, repository, active, journal },
        activation,
        context,
      ),
    list: (activationId?: ExecutionActivation['activationId']) => repository.list(activationId),
    claim: (id: string, owner: string) =>
      claimRun(repository, dependencies.clock, config, runId(id), owner),
    renewLease: (id: string, owner: string) =>
      renewLease(repository, dependencies.clock, config, runId(id), owner),
    requestCancellation: (
      id: string,
      reason: NonNullable<import('../contracts/views.js').RunView['cancellation']>['reason'],
    ) => requestCancellation(repository, dependencies.clock, runId(id), reason, active),
    confirmCancellation: (id: string) =>
      confirmCancellation(repository, dependencies.clock, runId(id)),
    cancelActive: (
      workflowInstanceIds: readonly string[],
      reason: NonNullable<import('../contracts/views.js').RunView['cancellation']>['reason'],
    ) => cancelActiveRuns(repository, dependencies.clock, workflowInstanceIds, reason, active),
  };
}

async function attemptExecution(
  runtime: ExecutionRuntime,
  activation: ExecutionActivation,
  context: ExecutionAttemptContext,
) {
  const definition = runtime.activities.describe(activation.activity);
  runtime.activities.validateInput(activation.activity, activation.input);
  validateResources(definition.resources, context.resources);
  const tier = activation.execution?.tier ?? runtime.config.defaultTier;
  if (runtime.config.tiers[tier] === undefined) throw new Error(`Unknown execution tier: ${tier}`);
  const resolvedRunner =
    definition.executionKind === ActivityExecutionKind.Agent
      ? runtime.dependencies.runners?.resolve(tier)
      : undefined;
  const runner = resolvedRunner?.runner;
  const runnerConfig =
    resolvedRunner === undefined ? undefined : runtime.config.agentRunners?.[resolvedRunner.name];
  const owner = context.owner ?? 'execution';
  const prior = await runtime.repository.list(activation.activationId);
  const existing = existingRun(prior, runtime.dependencies.clock, owner);
  if (existing !== undefined) return existing;
  const currentRunId = runId(runtime.dependencies.ids.next(ExecutionStreamKind.Run));
  const startedAt = runtime.dependencies.clock.now().toISOString();
  await claimActivation({
    journal: runtime.journal,
    clock: runtime.dependencies.clock,
    config: runtime.config,
    activationId: activation.activationId,
    runId: currentRunId,
    owner,
    occurredAt: startedAt,
  });
  let lease: WorkspaceLease | undefined;
  try {
    lease = await acquireWorkspace(
      activation.execution?.workspace ?? WorkspaceMode.None,
      context.workItemId,
      context.resources,
      runtime.dependencies.workspaces,
    );
    await runtime.repository.append(currentRunId, 0, [
      event({
        runId: currentRunId,
        eventId: `${currentRunId}:started`,
        eventType: ExecutionEventType.RunStarted,
        occurredAt: startedAt,
        correlationId: context.orchestrationGroupId,
        causationId: activation.activationId,
        payload: {
          activationId: activation.activationId,
          activity: activation.activity,
          workflowInstanceId: context.workflowInstanceId,
          orchestrationGroupId: context.orchestrationGroupId,
          attempt: prior.length + 1,
          startedAt,
          ...(resolvedRunner === undefined
            ? {}
            : {
                runner: {
                  name: resolvedRunner.name,
                  ...(runnerConfig?.model === undefined ? {} : { model: runnerConfig.model }),
                },
              }),
          ...(lease === undefined ? {} : { workspace: { mode: lease.mode, path: lease.path } }),
        },
      }),
    ]);
    await claimRun(
      runtime.repository,
      runtime.dependencies.clock,
      runtime.config,
      currentRunId,
      owner,
    );
    const outcome = await executeActivity(runtime, currentRunId, {
      activation,
      context,
      occurredAt: startedAt,
      runner,
    });
    await recordSuccess(runtime, currentRunId, activation, context, outcome);
  } catch (error) {
    await recordFailure(runtime, currentRunId, activation, context, error);
  } finally {
    await releaseActivation({
      journal: runtime.journal,
      clock: runtime.dependencies.clock,
      activationId: activation.activationId,
      runId: currentRunId,
    });
    runtime.active.delete(currentRunId);
    await lease?.release();
  }
  return (await runtime.repository.load(currentRunId)).view!;
}

function existingRun(
  runs: readonly import('../contracts/views.js').RunView[],
  clock: Clock,
  owner: string,
) {
  const completed = runs.find((run) => run.status === RunStatus.Succeeded);
  if (completed !== undefined) return completed;
  const ambiguous = runs.find((run) => run.status === RunStatus.Ambiguous);
  if (ambiguous !== undefined) return ambiguous;
  const active = runs.find((run) => run.status === RunStatus.Started);
  if (active === undefined) return undefined;
  if (
    active.lease !== undefined &&
    new Date(active.lease.expiresAt) > clock.now() &&
    active.lease.owner !== owner
  )
    throw new Error(`Run ${active.runId} has an unexpired lease`);
  return active;
}

async function recordSuccess(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  activation: ExecutionActivation,
  context: ExecutionAttemptContext,
  outcome: Awaited<ReturnType<typeof executeActivity>>,
): Promise<void> {
  const finishedAt = runtime.dependencies.clock.now().toISOString();
  const loaded = await runtime.repository.load(currentRunId);
  if (loaded.view?.status !== RunStatus.Started) return;
  await runtime.repository.append(currentRunId, loaded.sequence, [
    event({
      runId: currentRunId,
      eventId: `${currentRunId}:succeeded`,
      eventType: ExecutionEventType.RunSucceeded,
      occurredAt: finishedAt,
      correlationId: context.orchestrationGroupId,
      causationId: activation.activationId,
      payload: { outcome, finishedAt },
    }),
  ]);
}

async function recordFailure(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  activation: ExecutionActivation,
  context: ExecutionAttemptContext,
  error: unknown,
): Promise<void> {
  const loaded = await runtime.repository.load(currentRunId);
  if (loaded.sequence === 0) throw error;
  if (loaded.view?.status !== RunStatus.Started) return;
  const finishedAt = runtime.dependencies.clock.now().toISOString();
  await runtime.repository.append(currentRunId, loaded.sequence, [
    event({
      runId: currentRunId,
      eventId: `${currentRunId}:failed`,
      eventType: ExecutionEventType.RunFailed,
      occurredAt: finishedAt,
      correlationId: context.orchestrationGroupId,
      causationId: activation.activationId,
      payload: { failure: failureFrom(error), finishedAt },
    }),
  ]);
}
async function executeActivity(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  request: {
    readonly activation: ExecutionActivation;
    readonly context: ExecutionAttemptContext;
    readonly occurredAt: string;
    readonly runner: ActivityExecutionContext['runner'];
  },
) {
  const { activation, context, occurredAt, runner } = request;
  const controller = new AbortController();
  runtime.active.set(currentRunId, controller);
  const executionContext: ActivityExecutionContext = {
    signal: controller.signal,
    occurredAt,
    ...(runner === undefined ? {} : { runner }),
    reportExternalExecution: async (reference) => {
      const loaded = await runtime.repository.load(currentRunId);
      await runtime.repository.append(currentRunId, loaded.sequence, [
        event({
          runId: currentRunId,
          eventId: `${currentRunId}:external:${reference.id}`,
          eventType: ExecutionEventType.RunExternalExecutionReported,
          occurredAt: runtime.dependencies.clock.now().toISOString(),
          correlationId: context.orchestrationGroupId,
          causationId: activation.activationId,
          payload: reference,
        }),
      ]);
    },
  };
  return runtime.activities.execute(
    {
      activationId: activation.activationId,
      activity: activation.activity,
      workItemId: context.workItemId,
      workflowInstanceId: context.workflowInstanceId,
      orchestrationGroupId: context.orchestrationGroupId,
      causationId: activation.activationId,
      input: activation.input,
      resources: context.resources,
    },
    executionContext,
  );
}
function event<Type extends keyof RunExecutionEventPayloads>(input: {
  runId: ReturnType<typeof runId>;
  eventId: string;
  eventType: Type;
  occurredAt: string;
  correlationId: string;
  causationId: string;
  payload: RunExecutionEventPayloads[Type];
}) {
  return createEventDraft({
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    causationId: input.causationId,
    actor: { kind: EventActorKind.System, id: 'execution' },
    source: { kind: EventSourceKind.Internal, id: 'execution' },
    stream: runStream(input.runId),
    payload: input.payload,
  });
}

function validateResources(
  requirements: readonly ResourceRequirement[],
  resources: readonly ResourceView[],
): void {
  validateResourceRequirements(requirements, resources);
}
