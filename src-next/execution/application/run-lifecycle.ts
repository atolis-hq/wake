import {
  EventActorKind,
  EventSourceKind,
  createEventDraft,
  type Clock,
} from '../../kernel/index.js';
import type { ExecutionConfig } from '../contracts/config.js';
import { ExecutionEventType, type RunExecutionEventPayloads } from '../contracts/events.js';
import { runId } from '../contracts/identifiers.js';
import { runStream } from '../contracts/streams.js';
import { RunStatus } from '../contracts/vocabulary.js';
import type { WorkspaceLease } from '../contracts/workspace.js';
import { failureFrom } from '../domain/run-result.js';
import { claimRun } from './run-liveness-service.js';
import { RunRepository } from './run-repository.js';
import type { ActivityOutcome } from '../../activities/index.js';
import type { ExecutionActivation, ExecutionAttemptContext } from '../contracts/commands.js';

interface RunLifecycleDependencies {
  readonly clock: Clock;
  readonly config: ExecutionConfig;
  readonly repository: RunRepository;
}

interface ResolvedRunner {
  readonly name?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

export async function startRun(input: {
  readonly dependencies: RunLifecycleDependencies;
  readonly runId: ReturnType<typeof runId>;
  readonly activation: ExecutionActivation;
  readonly context: ExecutionAttemptContext;
  readonly attempt: number;
  readonly startedAt: string;
  readonly runner: ResolvedRunner;
  readonly lease: WorkspaceLease | undefined;
}): Promise<void> {
  const {
    dependencies,
    runId: currentRunId,
    activation,
    context,
    attempt,
    startedAt,
    runner,
    lease,
  } = input;
  await dependencies.repository.append(currentRunId, 0, [
    createRunEvent({
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
        attempt,
        startedAt,
        ...(runner.name === undefined
          ? {}
          : {
              runner: {
                name: runner.name,
                ...(runner.model === undefined ? {} : { model: runner.model }),
                ...(runner.effort === undefined ? {} : { effort: runner.effort }),
              },
            }),
        ...(lease === undefined ? {} : { workspace: { mode: lease.mode, path: lease.path } }),
      },
    }),
  ]);
  await claimRun(
    dependencies.repository,
    dependencies.clock,
    dependencies.config,
    currentRunId,
    context.owner ?? 'execution',
  );
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
}): Promise<void> {
  const { dependencies, runId: currentRunId, activation, context, error } = input;
  const loaded = await dependencies.repository.load(currentRunId);
  if (loaded.sequence === 0) throw error;
  if (loaded.view?.status !== RunStatus.Started) return;
  const finishedAt = dependencies.clock.now().toISOString();
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
