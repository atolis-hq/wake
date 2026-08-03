import {
  type ActivityExecutionContext,
  ActivityExecutionKind,
  type ActivityRegistry,
  type ResourceRequirement,
} from '../../activities/index.js';
import { type Clock, type EventJournal, type IdGenerator } from '../../kernel/index.js';
import type { ResourceView } from '../../resources/index.js';
import type { ExecutionActivation, ExecutionAttemptContext } from '../contracts/commands.js';
import type { ExecutionConfig } from '../contracts/config.js';
import { ExecutionEventType } from '../contracts/events.js';
import { runId } from '../contracts/identifiers.js';
import { ExecutionStreamKind } from '../contracts/streams.js';
import type { RunView } from '../contracts/views.js';
import { RunStatus, WorkspaceMode } from '../contracts/vocabulary.js';
import type { WorkspaceLease, WorkspaceProvider } from '../contracts/workspace.js';
import type { RunnerRegistry } from '../infrastructure/runners/registry.js';
import { parseAgentRunnerResponse } from '../infrastructure/agent-runner-adapter.js';
import { claimActivation, releaseActivation } from './activation-claim.js';
import { cancelActiveRuns } from './active-run-cancellation.js';
import { acquireWorkspace, validateResourceRequirements } from './execution-validation.js';
import { createRunEvent, recordRunFailure, recordRunSuccess, recordWorkspaceCleanupFailure, startRun } from './run-lifecycle.js';
import {
  claimRun,
  confirmCancellation,
  renewLease,
  requestCancellation,
} from './run-liveness-service.js';
import { RunRepository } from './run-repository.js';

export interface ExecutionDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly workspaces?: WorkspaceProvider;
  readonly runners?: RunnerRegistry;
  readonly reportRunnerQuota?: (input: {
    readonly runnerName: string;
    readonly message: string;
  }) => Promise<void>;
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
    requestCancellation: (id: string, reason: NonNullable<RunView['cancellation']>['reason']) =>
      requestCancellation(repository, dependencies.clock, runId(id), reason, active),
    confirmCancellation: (id: string) =>
      confirmCancellation(repository, dependencies.clock, runId(id)),
    cancelActive: (
      workflowInstanceIds: readonly string[],
      reason: NonNullable<RunView['cancellation']>['reason'],
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
  const runner = resolveRunner(runtime, definition.executionKind, activation, context);
  const owner = context.owner ?? 'execution';
  const prior = await runtime.repository.list(activation.activationId);
  const existing = existingRun(prior, runtime.dependencies.clock, owner);
  if (existing !== undefined) return existing;
  const currentRunId = runId(runtime.dependencies.ids.next(ExecutionStreamKind.Run));
  const startedAt = runtime.dependencies.clock.now().toISOString();
  await claimActivationForAttempt(runtime, activation, currentRunId, owner, startedAt);
  let lease: WorkspaceLease | undefined;
  try {
    lease = await acquireAttemptWorkspace(runtime, activation, context);
    await startRun({
      dependencies: runLifecycleDependencies(runtime),
      runId: currentRunId,
      activation,
      context,
      attempt: prior.length + 1,
      startedAt,
      runner,
      lease,
    });
    const outcome = await executeActivity(runtime, currentRunId, {
      activation,
      context,
      occurredAt: startedAt,
      runner: runner.runner,
      ...(runner.name === undefined ? {} : { runnerName: runner.name }),
    });
    await recordRunSuccess({
      dependencies: runLifecycleDependencies(runtime),
      runId: currentRunId,
      activation,
      context,
      outcome,
    });
  } catch (error) {
    await recordRunFailure({
      dependencies: runLifecycleDependencies(runtime),
      runId: currentRunId,
      activation,
      context,
      error,
    });
  } finally {
    await releaseActivation({
      journal: runtime.journal,
      clock: runtime.dependencies.clock,
      activationId: activation.activationId,
      runId: currentRunId,
    });
    runtime.active.delete(currentRunId);
    try {
      await lease?.release();
    } catch (error) {
      try {
        await recordWorkspaceCleanupFailure({
          dependencies: runLifecycleDependencies(runtime),
          runId: currentRunId,
          activation,
          context,
          error,
        });
      } catch {
        // A cleanup diagnostic must not make an already-finished run fatal.
      }
    }
  }
  return (await runtime.repository.load(currentRunId)).view!;
}

function resolveRunner(
  runtime: ExecutionRuntime,
  executionKind: ActivityExecutionKind,
  activation: ExecutionActivation,
  context: ExecutionAttemptContext,
) {
  const runnerPool = activation.execution?.runnerPool ?? runtime.config.defaultRunnerPool;
  if (runtime.config.runnerPools[runnerPool] === undefined)
    throw new Error(`Unknown execution runner pool: ${runnerPool}`);
  if (executionKind !== ActivityExecutionKind.Agent) return { runner: undefined };
  const resolved = runtime.dependencies.runners?.resolve(
    runnerPool,
    context.ineligibleRunners ?? new Set(),
  );
  return describeResolvedRunner(runtime, runnerPool, resolved);
}

function describeResolvedRunner(
  runtime: ExecutionRuntime,
  pool: string,
  resolved: ReturnType<NonNullable<ExecutionDependencies['runners']>['resolve']> | undefined,
) {
  if (resolved === undefined) return { runner: undefined };
  return {
    runner: resolved.runner,
    name: resolved.name,
    model: runtime.config.agentRunners?.[resolved.name]?.model,
    effort: runtime.config.agentRunners?.[resolved.name]?.effort,
    pool,
    cli: runtime.config.agentRunners?.[resolved.name]?.kind,
  };
}

function runLifecycleDependencies(runtime: ExecutionRuntime) {
  return {
    clock: runtime.dependencies.clock,
    config: runtime.config,
    repository: runtime.repository,
  };
}

async function claimActivationForAttempt(
  runtime: ExecutionRuntime,
  activation: ExecutionActivation,
  currentRunId: ReturnType<typeof runId>,
  owner: string,
  occurredAt: string,
): Promise<void> {
  await claimActivation({
    journal: runtime.journal,
    clock: runtime.dependencies.clock,
    config: runtime.config,
    activationId: activation.activationId,
    runId: currentRunId,
    owner,
    occurredAt,
  });
}

function acquireAttemptWorkspace(
  runtime: ExecutionRuntime,
  activation: ExecutionActivation,
  context: ExecutionAttemptContext,
) {
  return acquireWorkspace(
    activation.execution?.workspace ?? WorkspaceMode.None,
    context.workItemId,
    context.resources,
    runtime.dependencies.workspaces,
  );
}

function existingRun(runs: readonly RunView[], clock: Clock, owner: string) {
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

async function executeActivity(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  request: {
    readonly activation: ExecutionActivation;
    readonly context: ExecutionAttemptContext;
    readonly occurredAt: string;
    readonly runner: ActivityExecutionContext['runner'];
    readonly runnerName?: string;
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
        createRunEvent({
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
    reportRunnerResult: async (result) => {
      const loaded = await runtime.repository.load(currentRunId);
      await runtime.repository.append(currentRunId, loaded.sequence, [
        createRunEvent({
          runId: currentRunId,
          eventId: `${currentRunId}:runner-result`,
          eventType: ExecutionEventType.RunRunnerResultReported,
          occurredAt: runtime.dependencies.clock.now().toISOString(),
          correlationId: context.orchestrationGroupId,
          causationId: activation.activationId,
          payload: {
            transport: result.transport,
            agent: parseAgentRunnerResponse(result),
          },
        }),
      ]);
      if (result.failure?.kind === 'provider-quota-exceeded' && request.runnerName !== undefined)
        await runtime.dependencies.reportRunnerQuota?.({
          runnerName: request.runnerName,
          message: result.failure.message,
        });
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

function validateResources(
  requirements: readonly ResourceRequirement[],
  resources: readonly ResourceView[],
): void {
  validateResourceRequirements(requirements, resources);
}
