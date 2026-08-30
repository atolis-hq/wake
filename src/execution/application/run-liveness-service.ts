import {
  createEventData,
  EventActorKind,
  EventSourceKind,
  WrongExpectedSequenceError,
  type Clock,
} from '../../kernel/index.js';
import type { ExecutionConfig } from '../contracts/config.js';
import { ExecutionEventType, type RunExecutionEventPayloads } from '../contracts/events.js';
import type { runId } from '../contracts/identifiers.js';
import type { RunView } from '../contracts/views.js';
import { isActiveRunStatus } from '../contracts/vocabulary.js';
import type { RunRepository } from './run-repository.js';

const defaultLeaseDurationMs = 60_000;

export function newRunLease(clock: Clock, config: ExecutionConfig, owner: string) {
  const now = clock.now();
  return {
    owner,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + (config.leaseDurationMs ?? defaultLeaseDurationMs),
    ).toISOString(),
  };
}

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
  const lease = newRunLease(clock, config, owner);
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
  let retriedAfterSequence: number | undefined;
  while (true) {
    const loaded = await repository.load(currentRunId);
    const run = requireActiveRun(loaded.view);
    if (run.cancellation !== undefined) {
      active.get(currentRunId)?.abort(reason);
      return run;
    }
    if (retriedAfterSequence !== undefined && loaded.sequence <= retriedAfterSequence)
      throw new Error(`Run ${currentRunId} did not advance after a cancellation request conflict`);
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
      if (error instanceof WrongExpectedSequenceError) {
        retriedAfterSequence = loaded.sequence;
        continue;
      }
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
  let retriedAfterSequence: number | undefined;
  while (true) {
    const loaded = await repository.load(currentRunId);
    if (loaded.view === null) throw new Error('Run is not active');
    if (!isActiveRunStatus(loaded.view.status)) return loaded.view;
    if (loaded.view.cancellation === undefined)
      throw new Error(`Run ${currentRunId} has no cancellation request`);
    if (retriedAfterSequence !== undefined && loaded.sequence <= retriedAfterSequence)
      throw new Error(`Run ${currentRunId} did not advance after a cancellation conflict`);
    const confirmedAt = clock.now().toISOString();
    try {
      await repository.append(currentRunId, loaded.sequence, [
        livenessEvent(
          currentRunId,
          loaded.view,
          ExecutionEventType.RunCancellationConfirmed,
          { confirmedAt },
          confirmedAt,
        ),
        livenessEvent(
          currentRunId,
          loaded.view,
          ExecutionEventType.RunCancelled,
          { finishedAt: confirmedAt },
          confirmedAt,
        ),
      ]);
      return (await repository.load(currentRunId)).view!;
    } catch (error) {
      if (!(error instanceof WrongExpectedSequenceError)) throw error;
      retriedAfterSequence = loaded.sequence;
    }
  }
}

function requireActiveRun(run: RunView | null): RunView {
  if (run === null || !isActiveRunStatus(run.status)) throw new Error('Run is not active');
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
  return createEventData({
    eventId: `${currentRunId}:${eventType}:${occurredAt}`,
    eventType,
    occurredAt,
    correlationId: run.orchestrationGroupId,
    causationId: run.activationId,
    actor: { kind: EventActorKind.System, id: 'execution' },
    source: { kind: EventSourceKind.Internal, id: 'execution' },
    payload,
  });
}
