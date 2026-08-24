import {
  createEventDraft,
  EventActorKind,
  EventSourceKind,
  WrongExpectedSequenceError,
  type Clock,
} from '../../kernel/index.js';
import type { ExecutionConfig } from '../contracts/config.js';
import { ExecutionEventType, type RunExecutionEventPayloads } from '../contracts/events.js';
import type { runId } from '../contracts/identifiers.js';
import { runStream } from '../contracts/streams.js';
import type { RunView } from '../contracts/views.js';
import { RunStatus } from '../contracts/vocabulary.js';
import type { RunRepository } from './run-repository.js';

const defaultLeaseDurationMs = 60_000;

export async function claimRun(
  repository: RunRepository,
  clock: Clock,
  config: ExecutionConfig,
  currentRunId: ReturnType<typeof runId>,
  owner: string,
) {
  const loaded = await repository.load(currentRunId);
  const run = requireActiveRun(loaded.view);
  const now = clock.now();
  if (run.lease !== undefined && new Date(run.lease.expiresAt) > now && run.lease.owner !== owner)
    throw new Error(`Run ${currentRunId} has an unexpired lease`);
  const lease = {
    owner,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + (config.leaseDurationMs ?? defaultLeaseDurationMs),
    ).toISOString(),
  };
  await repository.append(currentRunId, loaded.sequence, [
    livenessEvent(currentRunId, run, ExecutionEventType.RunLeaseClaimed, lease, now.toISOString()),
  ]);
  return (await repository.load(currentRunId)).view!;
}

export async function renewLease(
  repository: RunRepository,
  clock: Clock,
  config: ExecutionConfig,
  currentRunId: ReturnType<typeof runId>,
  owner: string,
) {
  const loaded = await repository.load(currentRunId);
  const run = requireActiveRun(loaded.view);
  if (run.lease?.owner !== owner)
    throw new Error(`Run ${currentRunId} lease is not owned by ${owner}`);
  const now = clock.now();
  const renewalIntervalMs = config.leaseRenewalIntervalMs ?? 0;
  if (now.getTime() < new Date(run.lease.acquiredAt).getTime() + renewalIntervalMs)
    throw new Error(`Run ${currentRunId} lease renewal is not due`);
  const lease = {
    owner,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + (config.leaseDurationMs ?? defaultLeaseDurationMs),
    ).toISOString(),
  };
  await repository.append(currentRunId, loaded.sequence, [
    livenessEvent(currentRunId, run, ExecutionEventType.RunLeaseRenewed, lease, now.toISOString()),
  ]);
  return (await repository.load(currentRunId)).view!;
}

export async function requestCancellation(
  repository: RunRepository,
  clock: Clock,
  currentRunId: ReturnType<typeof runId>,
  reason: NonNullable<RunView['cancellation']>['reason'],
  active: ReadonlyMap<string, AbortController>,
) {
  while (true) {
    const loaded = await repository.load(currentRunId);
    const run = requireActiveRun(loaded.view);
    if (run.cancellation !== undefined) {
      active.get(currentRunId)?.abort(reason);
      return run;
    }
    const requestedAt = clock.now().toISOString();
    try {
      await repository.append(currentRunId, loaded.sequence, [
        livenessEvent(
          currentRunId,
          run,
          ExecutionEventType.RunCancellationRequested,
          { requestedAt, reason },
          requestedAt,
        ),
      ]);
    } catch (error) {
      if (error instanceof WrongExpectedSequenceError) continue;
      throw error;
    }
    active.get(currentRunId)?.abort(reason);
    return (await repository.load(currentRunId)).view!;
  }
}

export async function confirmCancellation(
  repository: RunRepository,
  clock: Clock,
  currentRunId: ReturnType<typeof runId>,
) {
  const loaded = await repository.load(currentRunId);
  const run = requireActiveRun(loaded.view);
  if (run.cancellation === undefined)
    throw new Error(`Run ${currentRunId} has no cancellation request`);
  const confirmedAt = clock.now().toISOString();
  await repository.append(currentRunId, loaded.sequence, [
    livenessEvent(
      currentRunId,
      run,
      ExecutionEventType.RunCancellationConfirmed,
      { confirmedAt },
      confirmedAt,
    ),
    livenessEvent(
      currentRunId,
      run,
      ExecutionEventType.RunCancelled,
      { finishedAt: confirmedAt },
      confirmedAt,
    ),
  ]);
  return (await repository.load(currentRunId)).view!;
}

function requireActiveRun(run: RunView | null): RunView {
  if (run === null || run.status !== RunStatus.Started) throw new Error('Run is not active');
  return run;
}

function livenessEvent<
  Type extends Exclude<
    keyof RunExecutionEventPayloads,
    | typeof ExecutionEventType.RunStarted
    | typeof ExecutionEventType.RunSucceeded
    | typeof ExecutionEventType.RunFailed
  >,
>(
  currentRunId: ReturnType<typeof runId>,
  run: RunView,
  eventType: Type,
  payload: RunExecutionEventPayloads[Type],
  occurredAt: string,
) {
  return createEventDraft({
    eventId: `${currentRunId}:${eventType}:${occurredAt}`,
    eventType,
    occurredAt,
    correlationId: run.orchestrationGroupId,
    causationId: run.activationId,
    actor: { kind: EventActorKind.System, id: 'execution' },
    source: { kind: EventSourceKind.Internal, id: 'execution' },
    stream: runStream(currentRunId),
    payload,
  });
}
