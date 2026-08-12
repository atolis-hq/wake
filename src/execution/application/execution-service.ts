import {
  ActivityExecutionKind,
  type ActivityRegistry,
  type ResourceRequirement,
} from '../../activities/index.js';
import { type Clock, type EventJournal } from '../../kernel/index.js';
import type { ResourceView } from '../../resources/index.js';
import type { ExecutionActivation, ExecutionAttemptContext } from '../contracts/commands.js';
import type { ExecutionConfig } from '../contracts/config.js';
import { runId } from '../contracts/identifiers.js';
import { ExecutionStreamKind } from '../contracts/streams.js';
import type { RunView } from '../contracts/views.js';
import { RunStatus, WorkspaceMode } from '../contracts/vocabulary.js';
import type { WorkspaceLease } from '../contracts/workspace.js';
import { claimActivation, releaseActivation } from './activation-claim.js';
import { cancelActiveRuns } from './active-run-cancellation.js';
import {
  executeActivity,
  type ExecutionDependencies,
  type ExecutionRuntime,
} from './execution-activity.js';
import { acquireWorkspace, validateResourceRequirements } from './execution-validation.js';
import {
  recordRunFailure,
  recordRunSuccess,
  recordWorkspaceCleanupFailure,
  startRun,
} from './run-lifecycle.js';
import {
  claimRun,
  confirmCancellation,
  renewLease,
  requestCancellation,
} from './run-liveness-service.js';
import { RunRepository } from './run-repository.js';

export type { ExecutionDependencies };

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
    isLocallyActive: (id: string) => active.has(runId(id)),
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
  const resumeSessionId = resumeSessionIdFor(
    context.sessionPolicy === 'resume-stage' ? await runtime.repository.list() : prior,
    runner.cli,
    {
      workflowInstanceId: context.workflowInstanceId,
      stage: activation.stage,
      ...(context.sessionPolicy === undefined ? {} : { policy: context.sessionPolicy }),
    },
  );
  const existing = existingRun(prior, runtime.dependencies.clock, owner);
  if (existing !== undefined) return existing;
  const currentRunId = runId(runtime.dependencies.ids.next(ExecutionStreamKind.Run));
  const startedAt = runtime.dependencies.clock.now().toISOString();
  let lease: WorkspaceLease | undefined;
  let claimed = false;
  try {
    await claimActivationForAttempt(runtime, activation, currentRunId, owner, startedAt);
    claimed = true;
    lease = await acquireAttemptWorkspace(runtime, activation, context, currentRunId);
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
  } catch (error) {
    const persisted = await runtime.repository.load(currentRunId);
    if (persisted.view?.status === RunStatus.Started) {
      try {
        await recordRunFailure({
          dependencies: runLifecycleDependencies(runtime),
          runId: currentRunId,
          activation,
          context,
          error,
        });
      } finally {
        await cleanupRun(runtime, currentRunId, activation, context, lease);
      }
      return (await runtime.repository.load(currentRunId)).view!;
    }
    await releasePreStartResources(runtime, activation, currentRunId, lease, claimed);
    throw error;
  }

  void completeRun(
    runtime,
    currentRunId,
    activation,
    context,
    startedAt,
    runner,
    resumeSessionId,
    lease,
  ).catch(() => {
    // A detached worker must never create an unhandled rejection for its caller.
  });
  return (await runtime.repository.load(currentRunId)).view!;
}

async function completeRun(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  activation: ExecutionActivation,
  context: ExecutionAttemptContext,
  startedAt: string,
  runner: ReturnType<typeof resolveRunner>,
  resumeSessionId: string | undefined,
  lease: WorkspaceLease | undefined,
): Promise<void> {
  const renewal = renewWhileRunning(runtime, currentRunId, context.owner ?? 'execution');
  try {
    const outcome = await executeActivity(runtime, currentRunId, {
      activation,
      context,
      occurredAt: startedAt,
      runner: runner.runner,
      ...(runner.name === undefined ? {} : { runnerName: runner.name }),
      ...(runner.model === undefined ? {} : { runnerModel: runner.model }),
      ...(runner.effort === undefined ? {} : { runnerEffort: runner.effort }),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      ...(lease === undefined ? {} : { workspace: { path: lease.path, mode: lease.mode } }),
    });
    await renewal.stop();
    await recordRunSuccess({
      dependencies: runLifecycleDependencies(runtime),
      runId: currentRunId,
      activation,
      context,
      outcome,
    });
  } catch (error) {
    try {
      await renewal.stop();
      await recordRunFailure({
        dependencies: runLifecycleDependencies(runtime),
        runId: currentRunId,
        activation,
        context,
        error,
      });
    } catch {
      // The caller already has a durable started Run; cleanup must still run.
    }
  } finally {
    await renewal.stop();
    await cleanupRun(runtime, currentRunId, activation, context, lease);
  }
}

function renewWhileRunning(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  owner: string,
): { stop(): Promise<void> } {
  const leaseDurationMs = runtime.config.leaseDurationMs ?? 60_000;
  const intervalMs =
    runtime.config.leaseRenewalIntervalMs ?? Math.max(1, Math.floor(leaseDurationMs / 2));
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || inFlight !== undefined) return;
    const renewal = renewLease(
      runtime.repository,
      runtime.dependencies.clock,
      runtime.config,
      currentRunId,
      owner,
    ).then(
      () => undefined,
      () => {
        // Recovery will reconcile a worker only after this process no longer tracks it.
      },
    );
    inFlight = renewal;
    void renewal.finally(() => {
      if (inFlight === renewal) inFlight = undefined;
    });
  }, intervalMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

async function cleanupRun(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  activation: ExecutionActivation,
  context: ExecutionAttemptContext,
  lease: WorkspaceLease | undefined,
): Promise<void> {
  try {
    await releaseActivation({
      journal: runtime.journal,
      clock: runtime.dependencies.clock,
      activationId: activation.activationId,
      runId: currentRunId,
    });
  } finally {
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
}

async function releasePreStartResources(
  runtime: ExecutionRuntime,
  activation: ExecutionActivation,
  currentRunId: ReturnType<typeof runId>,
  lease: WorkspaceLease | undefined,
  claimed: boolean,
): Promise<void> {
  if (claimed) {
    try {
      await releaseActivation({
        journal: runtime.journal,
        clock: runtime.dependencies.clock,
        activationId: activation.activationId,
        runId: currentRunId,
      });
    } catch {
      // Preserve the original pre-start failure.
    }
  }
  try {
    await lease?.release();
  } catch {
    // There is no durable Run on which to record a cleanup diagnostic.
  }
}

export function resumeSessionIdFor(
  prior: readonly RunView[],
  cli: string | undefined,
  scope?: {
    readonly policy?: 'fresh' | 'resume-stage';
    readonly workflowInstanceId: string;
    readonly stage?: string | undefined;
  },
) {
  if (cli === undefined || scope?.policy === 'fresh') return undefined;
  const eligible =
    scope?.policy !== 'resume-stage' || scope.stage === undefined
      ? prior
      : prior.filter(
          (run) => run.workflowInstanceId === scope.workflowInstanceId && run.stage === scope.stage,
        );
  return [...eligible]
    .filter((run) => isResumeTerminal(run.status))
    .sort(compareNewestTerminalRun)
    .find(
      (run) =>
        run.runner?.cli === cli &&
        typeof run.agent?.metadata.sessionId === 'string' &&
        run.agent.metadata.sessionId.trim().length > 0,
    )?.agent?.metadata.sessionId as string | undefined;
}

function isResumeTerminal(status: RunStatus): boolean {
  return (
    status === RunStatus.Succeeded || status === RunStatus.Failed || status === RunStatus.Cancelled
  );
}

function compareNewestTerminalRun(left: RunView, right: RunView): number {
  const byFinishedAt = (right.finishedAt ?? '').localeCompare(left.finishedAt ?? '');
  if (byFinishedAt !== 0) return byFinishedAt;
  const byAttempt = right.attempt - left.attempt;
  if (byAttempt !== 0) return byAttempt;
  return right.runId.localeCompare(left.runId);
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
  currentRunId: ReturnType<typeof runId>,
) {
  return acquireWorkspace(
    currentRunId,
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

function validateResources(
  requirements: readonly ResourceRequirement[],
  resources: readonly ResourceView[],
): void {
  validateResourceRequirements(requirements, resources);
}
