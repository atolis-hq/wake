import type { ActivityOutcome } from '../../activities/index.js';
import {
  createEventData,
  EventActorKind,
  EventSourceKind,
  WrongExpectedSequenceError,
  type Clock,
} from '../../kernel/index.js';
import type { ExecutionActivation, ExecutionAttemptContext } from '../contracts/commands.js';
import type { ExecutionConfig } from '../contracts/config.js';
import {
  ExecutionEventType,
  type RunExecutionEventPayloads,
  type RunPreparationStartedPayload,
} from '../contracts/events.js';
import type { runId } from '../contracts/identifiers.js';
import type { RunView } from '../contracts/views.js';
import { isActiveRunStatus, RunStatus } from '../contracts/vocabulary.js';
import type { WorkspaceLease } from '../contracts/workspace.js';
import { failureFrom } from '../domain/run-result.js';
import { newRunLease } from './run-liveness-service.js';
import type { RunRepository } from './run-repository.js';

interface RunLifecycleDependencies {
  readonly clock: Clock;
  readonly config: ExecutionConfig;
  readonly repository: RunRepository;
}

interface ResolvedRunner {
  readonly name?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly pool?: string | undefined;
  readonly cli?: string | undefined;
}

export async function prepareRun(input: {
  readonly dependencies: RunLifecycleDependencies;
  readonly runId: ReturnType<typeof runId>;
  readonly activation: ExecutionActivation;
  readonly context: ExecutionAttemptContext;
  readonly attempt: number;
  readonly startedAt: string;
  readonly runner: ResolvedRunner;
}): Promise<void> {
  const {
    dependencies,
    runId: currentRunId,
    activation,
    context,
    attempt,
    startedAt,
    runner,
  } = input;
  const lease = newRunLease(dependencies.clock, dependencies.config, context.owner ?? 'execution');
  await dependencies.repository.append(currentRunId, 0, [
    createRunEvent({
      runId: currentRunId,
      eventId: `${currentRunId}:preparation-started`,
      eventType: ExecutionEventType.RunPreparationStarted,
      occurredAt: startedAt,
      correlationId: context.orchestrationGroupId,
      causationId: activation.activationId,
      payload: {
        ...runPreparationPayload(activation, context, attempt, runner),
        startedAt,
      },
    }),
    createRunEvent({
      runId: currentRunId,
      eventId: `${currentRunId}:lease-claimed`,
      eventType: ExecutionEventType.RunLeaseClaimed,
      occurredAt: lease.acquiredAt,
      correlationId: context.orchestrationGroupId,
      causationId: activation.activationId,
      payload: lease,
    }),
  ]);
}

export async function startRun(input: {
  readonly dependencies: RunLifecycleDependencies;
  readonly runId: ReturnType<typeof runId>;
  readonly activation: ExecutionActivation;
  readonly context: ExecutionAttemptContext;
  readonly attempt: number;
  readonly runner: ResolvedRunner;
  readonly lease: WorkspaceLease | undefined;
}): Promise<string | undefined> {
  const { dependencies, runId: currentRunId, activation, context, attempt, runner, lease } = input;
  let retriedAfterSequence: number | undefined;
  while (true) {
    const loaded = await dependencies.repository.load(currentRunId);
    if (loaded.view?.status !== RunStatus.Starting || loaded.view.cancellation !== undefined)
      return undefined;
    if (retriedAfterSequence !== undefined && loaded.sequence <= retriedAfterSequence)
      throw new Error(`Run ${currentRunId} did not advance after a start append conflict`);
    const startedAt = dependencies.clock.now().toISOString();
    try {
      await dependencies.repository.append(currentRunId, loaded.sequence, [
        createRunEvent({
          runId: currentRunId,
          eventId: `${currentRunId}:started`,
          eventType: ExecutionEventType.RunStarted,
          occurredAt: startedAt,
          correlationId: context.orchestrationGroupId,
          causationId: activation.activationId,
          payload: {
            ...runPreparationPayload(activation, context, attempt, runner),
            startedAt,
            ...(lease === undefined
              ? {}
              : {
                  workspace: {
                    mode: lease.mode,
                    path: lease.path,
                    ...(lease.branch === undefined ? {} : { branch: lease.branch }),
                  },
                }),
          },
        }),
      ]);
      return startedAt;
    } catch (error) {
      if (!(error instanceof WrongExpectedSequenceError)) throw error;
      retriedAfterSequence = loaded.sequence;
    }
  }
}

function runPreparationPayload(
  activation: ExecutionActivation,
  context: ExecutionAttemptContext,
  attempt: number,
  runner: ResolvedRunner,
): Omit<RunPreparationStartedPayload, 'startedAt'> {
  return {
    activationId: activation.activationId,
    activity: activation.activity,
    ...(activation.stage === undefined ? {} : { stage: activation.stage }),
    workflowInstanceId: context.workflowInstanceId,
    orchestrationGroupId: context.orchestrationGroupId,
    attempt,
    ...(runner.name === undefined
      ? {}
      : {
          runner: {
            name: runner.name,
            ...(runner.model === undefined ? {} : { model: runner.model }),
            ...(runner.effort === undefined ? {} : { effort: runner.effort }),
            ...(runner.pool === undefined ? {} : { pool: runner.pool }),
            ...(runner.cli === undefined ? {} : { cli: runner.cli }),
          },
        }),
  };
}

export async function recordWorkspaceCleanupFailure(input: {
  readonly dependencies: RunLifecycleDependencies;
  readonly runId: ReturnType<typeof runId>;
  readonly activation: ExecutionActivation;
  readonly context: ExecutionAttemptContext;
  readonly error: unknown;
}): Promise<void> {
  const { dependencies, runId: currentRunId, activation, context, error } = input;
  const loaded = await dependencies.repository.load(currentRunId);
  await dependencies.repository.append(currentRunId, loaded.sequence, [
    createRunEvent({
      runId: currentRunId,
      eventId: `${currentRunId}:workspace-cleanup-failed`,
      eventType: ExecutionEventType.RunWorkspaceCleanupFailed,
      occurredAt: dependencies.clock.now().toISOString(),
      correlationId: context.orchestrationGroupId,
      causationId: activation.activationId,
      payload: { message: error instanceof Error ? error.message : `${error}` },
    }),
  ]);
}

export async function recordRunSuccess(input: {
  readonly dependencies: RunLifecycleDependencies;
  readonly runId: ReturnType<typeof runId>;
  readonly activation: ExecutionActivation;
  readonly context: ExecutionAttemptContext;
  readonly outcome: ActivityOutcome;
}): Promise<void> {
  const { dependencies, runId: currentRunId, activation, context, outcome } = input;
  const finishedAt = dependencies.clock.now().toISOString();
  const loaded = await dependencies.repository.load(currentRunId);
  if (loaded.view?.status !== RunStatus.Started) return;
  await dependencies.repository.append(currentRunId, loaded.sequence, [
    createRunEvent({
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

export async function recordRunFailure(input: {
  readonly dependencies: RunLifecycleDependencies;
  readonly runId: ReturnType<typeof runId>;
  readonly activation: ExecutionActivation;
  readonly context: ExecutionAttemptContext;
  readonly error: unknown;
}): Promise<RunView | null | undefined> {
  const { dependencies, runId: currentRunId, activation, context, error } = input;
  let retriedAfterSequence: number | undefined;
  while (true) {
    const loaded = await dependencies.repository.load(currentRunId);
    if (loaded.sequence === 0) throw error;
    if (loaded.view === null || !isActiveRunStatus(loaded.view.status)) return;
    if (loaded.view.cancellation !== undefined) return loaded.view;
    if (retriedAfterSequence !== undefined && loaded.sequence <= retriedAfterSequence)
      throw new Error(`Run ${currentRunId} did not advance after a failure append conflict`);
    const finishedAt = dependencies.clock.now().toISOString();
    try {
      await dependencies.repository.append(currentRunId, loaded.sequence, [
        createRunEvent({
          runId: currentRunId,
          eventId: `${currentRunId}:failed`,
          eventType: ExecutionEventType.RunFailed,
          occurredAt: finishedAt,
          correlationId: context.orchestrationGroupId,
          causationId: activation.activationId,
          payload: { failure: failureFrom(error), finishedAt },
        }),
      ]);
      return (await dependencies.repository.load(currentRunId)).view;
    } catch (appendError) {
      if (!(appendError instanceof WrongExpectedSequenceError)) throw appendError;
      retriedAfterSequence = loaded.sequence;
    }
  }
}

export function createRunEvent<Type extends keyof RunExecutionEventPayloads>(input: {
  runId: ReturnType<typeof runId>;
  eventId: string;
  eventType: Type;
  occurredAt: string;
  correlationId: string;
  causationId: string;
  payload: RunExecutionEventPayloads[Type];
}) {
  return createEventData({
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    causationId: input.causationId,
    actor: { kind: EventActorKind.System, id: 'execution' },
    source: { kind: EventSourceKind.Internal, id: 'execution' },
    payload: input.payload,
  });
}
