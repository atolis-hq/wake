/* eslint-disable max-lines */

import { type EventJournal } from '@atolis-hq/eventing';
import {
  ActivityExecutionKind,
  type ActivityRegistry,
  type ResourceRequirement,
} from '../../activities/index.js';
import { type Clock } from '../../kernel/index.js';
import type { ResourceView } from '../../resources/index.js';
import type { ExecutionActivation, ExecutionAttemptContext } from '../contracts/commands.js';
import type { ExecutionConfig } from '../contracts/config.js';
import { runId } from '../contracts/identifiers.js';
import { ExecutionStreamKind } from '../contracts/streams.js';
import type { RunView } from '../contracts/views.js';
import {
  ExecutionCancellationReason,
  isActiveRunStatus,
  RunStatus,
  WorkspaceMode,
} from '../contracts/vocabulary.js';
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
  prepareRun,
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
  const localAttempts = new Set<string>();
  const lifecycle: ExecutionRuntime['lifecycle'] = {
    closed: false,
    shutdown: undefined,
    attempts: new Set(),
    cancellations: new Map(),
    workers: new Map(),
  };
  const runtime = {
    activities,
    config,
    dependencies,
    repository,
    active,
    localAttempts,
    lifecycle,
    journal,
  };
  return {
    attempt: (activation: ExecutionActivation, context: ExecutionAttemptContext) =>
      startAttempt(runtime, activation, context),
    list: (activationId?: ExecutionActivation['activationId']) => repository.list(activationId),
    isLocallyActive: (id: string) => localAttempts.has(runId(id)),
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
    shutdown: () => (lifecycle.shutdown ??= shutdownExecution(runtime)),
  };
}

function startAttempt(
  runtime: ExecutionRuntime,
  activation: ExecutionActivation,
  context: ExecutionAttemptContext,
): Promise<RunView> {
  if (runtime.lifecycle.closed) return Promise.reject(new Error('Execution service is shut down'));
  const attempt = attemptExecution(runtime, activation, context);
  runtime.lifecycle.attempts.add(attempt);
  void attempt.finally(() => runtime.lifecycle.attempts.delete(attempt)).catch(() => undefined);
  return attempt;
}

async function shutdownExecution(runtime: ExecutionRuntime): Promise<void> {
  runtime.lifecycle.closed = true;
  while (
    runtime.lifecycle.attempts.size > 0 ||
    runtime.lifecycle.cancellations.size > 0 ||
    runtime.lifecycle.workers.size > 0
  ) {
    const attempts = [...runtime.lifecycle.attempts];
    const pendingCancellations = [...runtime.lifecycle.cancellations.values()];
    const workers = [...runtime.lifecycle.workers.values()];
    const controllers = [...runtime.active.entries()];
    const cancellations = controllers.map(([currentRunId]) =>
      beginShutdownCancellation(runtime, runId(currentRunId)),
    );
    for (const [, controller] of controllers)
      if (!controller.signal.aborted) controller.abort(ExecutionCancellationReason.Shutdown);
    await Promise.allSettled([
      ...attempts,
      ...workers.map(({ completion }) => completion),
      ...pendingCancellations,
      ...cancellations,
    ]);
  }
}

function beginShutdownCancellation(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
): Promise<boolean> {
  const existing = runtime.lifecycle.cancellations.get(currentRunId);
  if (existing !== undefined) return existing;
  const pending = requestCancellation(
    runtime.repository,
    runtime.dependencies.clock,
    currentRunId,
    ExecutionCancellationReason.Shutdown,
    runtime.active,
  ).then(
    () => true,
    () => false,
  );
  runtime.lifecycle.cancellations.set(currentRunId, pending);
  return pending;
}

// Prepares the durable Run before workspace acquisition, then hands invocation to the detached worker.
// eslint-disable-next-line max-lines-per-function
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
  const resumeCandidates =
    context.sessionPolicy === 'resume-stage' ? await runtime.repository.list() : prior;
  const resumeScope = {
    workflowInstanceId: context.workflowInstanceId,
    stage: activation.stage,
    ...(context.sessionPolicy === undefined ? {} : { policy: context.sessionPolicy }),
  };
  const resume = resumeContextFor(resumeCandidates, runner, resumeScope);
  const existing = existingRun(prior, runtime.dependencies.clock, owner);
  if (existing !== undefined) return existing;
  const currentRunId = runId(runtime.dependencies.ids.next(ExecutionStreamKind.Run));
  const startedAt = runtime.dependencies.clock.now().toISOString();
  const reportRunnerStarted = () => undefined;
  let lease: WorkspaceLease | undefined;
  let renewal: ReturnType<typeof renewWhileActive> | undefined;
  let claimed = false;
  try {
    await claimActivationForAttempt(runtime, activation, currentRunId, owner, startedAt);
    claimed = true;
    await prepareRun({
      dependencies: runLifecycleDependencies(runtime),
      runId: currentRunId,
      activation,
      context,
      attempt: prior.length + 1,
      startedAt,
      runner,
    });
    runtime.localAttempts.add(currentRunId);
    renewal = renewWhileActive(runtime, currentRunId, owner);
    const controller = createExecutionController(runtime, currentRunId);
    if (definition.executionKind !== ActivityExecutionKind.Deterministic) {
      const prepared = (await runtime.repository.load(currentRunId)).view!;
      const detachedAttempt = {
        activation,
        context,
        currentRunId,
        attempt: prior.length + 1,
        runner,
        resume,
        renewal,
        reportRunnerStarted,
        controller,
      };
      const worker = trackExecutionWorker(
        runtime,
        currentRunId,
        controller,
        continueDetachedAttemptOnNextTurn(runtime, detachedAttempt),
      );
      void worker.catch(() => {
        reportRunnerStarted();
        // The worker has already attempted durable settlement; never leak its rejection.
      });
      return prepared;
    }
    lease = await acquireAttemptWorkspace(
      runtime,
      activation,
      context,
      currentRunId,
      controller.signal,
    );
    const executionStartedAt = await startRun({
      dependencies: runLifecycleDependencies(runtime),
      runId: currentRunId,
      activation,
      context,
      attempt: prior.length + 1,
      runner,
      lease,
    });
    if (executionStartedAt === undefined) {
      await confirmCancellation(runtime.repository, runtime.dependencies.clock, currentRunId);
      await renewal.stop();
      await cleanupRun(runtime, currentRunId, activation, context, { lease });
      return (await runtime.repository.load(currentRunId)).view!;
    }
    const completion = trackExecutionWorker(
      runtime,
      currentRunId,
      controller,
      completeRun(
        runtime,
        currentRunId,
        activation,
        context,
        executionStartedAt,
        runner,
        resume.sessionId,
        resume.startedAt,
        resume.usageBaseline,
        lease,
        renewal,
        reportRunnerStarted,
      ),
    );
    void completion.catch(() => {
      reportRunnerStarted();
      // A detached worker must never create an unhandled rejection for its caller.
    });
  } catch (error) {
    return recoverFailedAttempt(
      runtime,
      { activation, context, currentRunId, renewal, lease, claimed },
      error,
    );
  }
  await yieldToRunStart(context.awaitImmediateCompletion ? undefined : Promise.resolve());
  return (await runtime.repository.load(currentRunId)).view!;
}

type DetachedAttempt = {
  readonly activation: ExecutionActivation;
  readonly context: ExecutionAttemptContext;
  readonly currentRunId: ReturnType<typeof runId>;
  readonly attempt: number;
  readonly runner: ReturnType<typeof resolveRunner>;
  readonly resume: ReturnType<typeof resumeContextFor>;
  readonly renewal: ReturnType<typeof renewWhileActive>;
  readonly reportRunnerStarted: () => void;
  readonly controller: AbortController;
};

function continueDetachedAttemptOnNextTurn(
  runtime: ExecutionRuntime,
  attempt: DetachedAttempt,
): Promise<RunView> {
  return new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => continueDetachedAttempt(runtime, attempt))
    .finally(async () => {
      try {
        await attempt.renewal.stop();
      } finally {
        runtime.active.delete(attempt.currentRunId);
        runtime.localAttempts.delete(attempt.currentRunId);
      }
    });
}

function createExecutionController(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
): AbortController {
  const controller = new AbortController();
  runtime.active.set(currentRunId, controller);
  if (runtime.lifecycle.closed) {
    void beginShutdownCancellation(runtime, currentRunId);
    controller.abort(ExecutionCancellationReason.Shutdown);
  }
  return controller;
}

function trackExecutionWorker<T>(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  controller: AbortController,
  completion: Promise<T>,
): Promise<T> {
  const tracked = completion.finally(() => {
    if (runtime.lifecycle.workers.get(currentRunId)?.completion === tracked)
      runtime.lifecycle.workers.delete(currentRunId);
    runtime.lifecycle.cancellations.delete(currentRunId);
  });
  runtime.lifecycle.workers.set(currentRunId, { controller, completion: tracked });
  return tracked;
}

async function continueDetachedAttempt(
  runtime: ExecutionRuntime,
  attempt: DetachedAttempt,
): Promise<RunView> {
  const {
    activation,
    context,
    currentRunId,
    attempt: attemptNumber,
    runner,
    resume,
    renewal,
    reportRunnerStarted,
    controller,
  } = attempt;
  let lease: WorkspaceLease | undefined;
  try {
    lease = await acquireAttemptWorkspace(
      runtime,
      activation,
      context,
      currentRunId,
      controller.signal,
    );
    const executionStartedAt = await startRun({
      dependencies: runLifecycleDependencies(runtime),
      runId: currentRunId,
      activation,
      context,
      attempt: attemptNumber,
      runner,
      lease,
    });
    if (executionStartedAt === undefined) {
      await confirmCancellation(runtime.repository, runtime.dependencies.clock, currentRunId);
      await renewal.stop();
      await cleanupRun(runtime, currentRunId, activation, context, {
        lease,
        preserveLocalAttempt: true,
      });
      return (await runtime.repository.load(currentRunId)).view!;
    }
    const completion = completeRun(
      runtime,
      currentRunId,
      activation,
      context,
      executionStartedAt,
      runner,
      resume.sessionId,
      resume.startedAt,
      resume.usageBaseline,
      lease,
      renewal,
      reportRunnerStarted,
      true,
    );
    await completion;
    return (await runtime.repository.load(currentRunId)).view!;
  } catch (error) {
    return recoverFailedAttempt(
      runtime,
      {
        activation,
        context,
        currentRunId,
        renewal,
        lease,
        claimed: true,
        preserveLocalAttempt: true,
      },
      error,
    );
  }
}

async function recoverFailedAttempt(
  runtime: ExecutionRuntime,
  attempt: {
    readonly activation: ExecutionActivation;
    readonly context: ExecutionAttemptContext;
    readonly currentRunId: ReturnType<typeof runId>;
    readonly renewal: ReturnType<typeof renewWhileActive> | undefined;
    readonly lease: WorkspaceLease | undefined;
    readonly claimed: boolean;
    readonly preserveLocalAttempt?: boolean | undefined;
  },
  error: unknown,
): Promise<RunView> {
  const { activation, context, currentRunId, renewal, lease, claimed } = attempt;
  try {
    const persisted = await runtime.repository.load(currentRunId);
    if (persisted.view !== null) {
      await renewal?.stop();
      const settled = await runtime.repository.load(currentRunId);
      if (settled.view !== null && !isActiveRunStatus(settled.view.status)) {
        await cleanupRun(runtime, currentRunId, activation, context, {
          lease,
          preserveLocalAttempt: attempt.preserveLocalAttempt,
        });
        return settled.view;
      }
      if (settled.view === null) {
        await releasePreStartResources(runtime, activation, currentRunId, {
          lease,
          claimed,
          preserveLocalAttempt: attempt.preserveLocalAttempt,
        });
        throw error;
      }
      try {
        await settleRunFailure(runtime, currentRunId, activation, context, error);
      } finally {
        await cleanupRun(runtime, currentRunId, activation, context, {
          lease,
          preserveLocalAttempt: attempt.preserveLocalAttempt,
        });
      }
      return (await runtime.repository.load(currentRunId)).view!;
    }
    await renewal?.stop();
    await releasePreStartResources(runtime, activation, currentRunId, {
      lease,
      claimed,
      preserveLocalAttempt: attempt.preserveLocalAttempt,
    });
    throw error;
  } finally {
    await renewal?.stop();
    await runtime.lifecycle.cancellations.get(currentRunId);
    runtime.lifecycle.cancellations.delete(currentRunId);
  }
}

async function yieldToRunStart(runnerStarted: Promise<void> | undefined): Promise<void> {
  if (runnerStarted !== undefined) return runnerStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// A Run completion atomically carries the full execution lease context.
// eslint-disable-next-line max-params
async function completeRun(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  activation: ExecutionActivation,
  context: ExecutionAttemptContext,
  startedAt: string,
  runner: ReturnType<typeof resolveRunner>,
  resumeSessionId: string | undefined,
  resumeStartedAt: string | undefined,
  usageBaseline: ReturnType<typeof usageBaselineFor>,
  lease: WorkspaceLease | undefined,
  renewal: ReturnType<typeof renewWhileActive>,
  reportRunnerStarted: () => void,
  preserveLocalAttempt = false,
): Promise<void> {
  let renewalStopped = false;
  const stopRenewal = async () => {
    if (renewalStopped) return;
    renewalStopped = true;
    await renewal.stop();
  };
  try {
    const outcome = await executeActivity(runtime, currentRunId, {
      activation,
      context,
      occurredAt: startedAt,
      runner: runner.runner,
      ...(runner.name === undefined ? {} : { runnerName: runner.name }),
      ...(runner.cli === undefined ? {} : { runnerCli: runner.cli }),
      ...(runner.model === undefined ? {} : { runnerModel: runner.model }),
      ...(runner.effort === undefined ? {} : { runnerEffort: runner.effort }),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      ...(resumeStartedAt === undefined ? {} : { resumeStartedAt }),
      ...(usageBaseline === undefined ? {} : { usageBaseline }),
      ...(lease === undefined ? {} : { workspace: { path: lease.path, mode: lease.mode } }),
      reportRunnerStarted,
    });
    await stopRenewal();
    await recordRunSuccess({
      dependencies: runLifecycleDependencies(runtime),
      runId: currentRunId,
      activation,
      context,
      outcome,
    });
  } catch (error) {
    try {
      await stopRenewal();
      await settleRunFailure(runtime, currentRunId, activation, context, error);
    } catch {
      // The caller already has a durable started Run; cleanup must still run.
    }
  } finally {
    reportRunnerStarted();
    await stopRenewal();
    await cleanupRun(runtime, currentRunId, activation, context, {
      lease,
      preserveLocalAttempt,
    });
  }
}

async function settleRunFailure(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  activation: ExecutionActivation,
  context: ExecutionAttemptContext,
  error: unknown,
): Promise<void> {
  await runtime.lifecycle.cancellations.get(currentRunId);
  const run = await recordRunFailure({
    dependencies: runLifecycleDependencies(runtime),
    runId: currentRunId,
    activation,
    context,
    error,
  });
  if (
    run !== null &&
    run !== undefined &&
    isActiveRunStatus(run.status) &&
    run.cancellation !== undefined
  )
    await confirmCancellation(runtime.repository, runtime.dependencies.clock, currentRunId);
}

function renewWhileActive(
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
  options: {
    readonly lease: WorkspaceLease | undefined;
    readonly preserveLocalAttempt?: boolean | undefined;
  },
): Promise<void> {
  const { lease } = options;
  try {
    await releaseActivation({
      journal: runtime.journal,
      clock: runtime.dependencies.clock,
      activationId: activation.activationId,
      runId: currentRunId,
    });
  } catch {
    // An activation release can be retried after its claim expires; it must not mask the Run result.
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
    } finally {
      runtime.lifecycle.cancellations.delete(currentRunId);
      if (options.preserveLocalAttempt !== true) runtime.localAttempts.delete(currentRunId);
    }
  }
}

async function releasePreStartResources(
  runtime: ExecutionRuntime,
  activation: ExecutionActivation,
  currentRunId: ReturnType<typeof runId>,
  options: {
    readonly lease: WorkspaceLease | undefined;
    readonly claimed: boolean;
    readonly preserveLocalAttempt?: boolean | undefined;
  },
): Promise<void> {
  const { lease, claimed } = options;
  if (options.preserveLocalAttempt !== true) runtime.localAttempts.delete(currentRunId);
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
  runnerName?: string,
) {
  return resumeRunFor(prior, cli, runnerName, scope)?.agent?.metadata.sessionId as
    string | undefined;
}

function resumeContextFor(
  candidates: readonly RunView[],
  runner: ReturnType<typeof resolveRunner>,
  scope: Parameters<typeof resumeRunFor>[3],
) {
  if (runner.supportsSessionResume !== true) return {};
  const resumedRun = resumeRunFor(candidates, runner.cli, runner.name, scope);
  const sessionId = resumedRun?.agent?.metadata.sessionId as string | undefined;
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(resumedRun?.startedAt === undefined ? {} : { startedAt: resumedRun.startedAt }),
    ...(sessionId === undefined
      ? {}
      : {
          usageBaseline: usageBaselineFor(candidates, runner.cli, sessionId, scope, runner.name),
        }),
  };
}

function resumeRunFor(
  prior: readonly RunView[],
  cli: string | undefined,
  runnerName: string | undefined,
  scope?: {
    readonly policy?: 'fresh' | 'resume-stage';
    readonly workflowInstanceId: string;
    readonly stage?: string | undefined;
  },
) {
  if (cli === undefined || scope?.policy === 'fresh') return undefined;
  return [...resumeEligibleRuns(prior, scope)]
    .filter((run) => isResumeTerminal(run.status))
    .sort(compareNewestTerminalRun)
    .find(
      (run) =>
        run.runner?.cli === cli &&
        (runnerName === undefined || run.runner?.name === runnerName) &&
        typeof run.agent?.metadata.sessionId === 'string' &&
        run.agent.metadata.sessionId.trim().length > 0,
    );
}

export function usageBaselineFor(
  prior: readonly RunView[],
  cli: string | undefined,
  sessionId: string | undefined,
  scope?: {
    readonly policy?: 'fresh' | 'resume-stage';
    readonly workflowInstanceId: string;
    readonly stage?: string | undefined;
  },
  runnerName?: string,
) {
  if (cli === undefined || sessionId === undefined) return undefined;
  const matching = resumeEligibleRuns(prior, scope).filter(
    (run) =>
      isResumeTerminal(run.status) &&
      run.runner?.cli === cli &&
      (runnerName === undefined || run.runner?.name === runnerName) &&
      run.agent?.metadata.sessionId === sessionId,
  );
  if (matching.length === 0) return undefined;
  const requiredInput = sumCompleteCounters(matching, 'inputTokens');
  const requiredOutput = sumCompleteCounters(matching, 'outputTokens');
  if (requiredInput === undefined || requiredOutput === undefined) return undefined;
  const cacheRead = optionalCacheBaseline(matching, 'cacheReadTokens');
  const cacheWrite = optionalCacheBaseline(matching, 'cacheWriteTokens');
  if (cacheRead === 'invalid' || cacheWrite === 'invalid') return undefined;
  return {
    input: requiredInput,
    output: requiredOutput,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

function sumCompleteCounters(runs: readonly RunView[], key: string): number | undefined {
  let total = 0;
  for (const run of runs) {
    const value = run.agent?.metadata[key];
    if (!isValidHistoricalCounter(value)) return undefined;
    total += value;
  }
  return total;
}

function optionalCacheBaseline(
  runs: readonly RunView[],
  key: string,
): number | 'invalid' | undefined {
  const values = runs.map((run) => run.agent?.metadata[key]);
  let incomplete = false;
  let total = 0;
  for (const value of values) {
    if (value === undefined) {
      incomplete = true;
      continue;
    }
    if (!isValidHistoricalCounter(value)) return 'invalid';
    total += value;
  }
  return incomplete ? undefined : total;
}

function isValidHistoricalCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function resumeEligibleRuns(
  prior: readonly RunView[],
  scope:
    | {
        readonly policy?: 'fresh' | 'resume-stage';
        readonly workflowInstanceId: string;
        readonly stage?: string | undefined;
      }
    | undefined,
) {
  return scope?.policy !== 'resume-stage' || scope.stage === undefined
    ? prior
    : prior.filter(
        (run) => run.workflowInstanceId === scope.workflowInstanceId && run.stage === scope.stage,
      );
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
    supportsSessionResume: resolved.runner.supportsSessionResume === true,
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
  signal?: AbortSignal,
) {
  return acquireWorkspace(
    currentRunId,
    activation.execution?.workspace ?? WorkspaceMode.None,
    context.workItemId,
    context.resources,
    runtime.dependencies.workspaces,
    signal,
  );
}

function existingRun(runs: readonly RunView[], clock: Clock, owner: string) {
  const completed = runs.find((run) => run.status === RunStatus.Succeeded);
  if (completed !== undefined) return completed;
  const ambiguous = runs.find((run) => run.status === RunStatus.Ambiguous);
  if (ambiguous !== undefined) return ambiguous;
  const active = runs.find((run) => isActiveRunStatus(run.status));
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
