import type { ActivationId } from '../../activities/index.js';
import {
  EventActorKind,
  EventSourceKind,
  type Clock,
  type EventJournal,
} from '../../kernel/index.js';
import type { ExecutionConfig } from '../contracts/config.js';
import { createActivationExecutionEventData } from '../contracts/event-factory.js';
import {
  decodeActivationExecutionEvent,
  ExecutionEventType,
  type ActivationExecutionEvent,
} from '../contracts/events.js';
import type { RunId } from '../contracts/identifiers.js';
import { activationStream } from '../contracts/streams.js';

export class ActivationClaimConflictError extends Error {
  constructor(activationId: ActivationId) {
    super(`Activation ${activationId} already has an active Run claim`);
    this.name = 'ActivationClaimConflictError';
  }
}

export async function claimActivation(input: {
  readonly journal: EventJournal;
  readonly clock: Clock;
  readonly config: ExecutionConfig;
  readonly activationId: ActivationId;
  readonly runId: RunId;
  readonly owner: string;
  readonly occurredAt: string;
}): Promise<void> {
  const { journal, clock, config, activationId, runId, owner, occurredAt } = input;
  const stream = activationStream(activationId);
  const events = (await journal.readStream(stream)).map(decodeActivationExecutionEvent);
  const last = events.at(-1);
  if (
    last?.event.eventType === ExecutionEventType.ActivationClaimed &&
    claimIsUnexpired(last.event, clock)
  )
    throw new ActivationClaimConflictError(activationId);
  await journal.appendToStream(stream, events.length, [
    createActivationExecutionEventData({
      eventId: `${activationId}:claim:${runId}`,
      eventType: ExecutionEventType.ActivationClaimed,
      occurredAt,
      correlationId: activationId,
      causationId: runId,
      actor: { kind: EventActorKind.System, id: owner },
      source: { kind: EventSourceKind.Internal, id: 'execution' },
      payload: {
        runId,
        owner,
        expiresAt: new Date(
          clock.now().getTime() + (config.leaseDurationMs ?? 60_000),
        ).toISOString(),
      },
    }),
  ]);
}

export async function releaseActivation(input: {
  readonly journal: EventJournal;
  readonly clock: Clock;
  readonly activationId: ActivationId;
  readonly runId: RunId;
}): Promise<void> {
  const { journal, clock, activationId, runId } = input;
  const stream = activationStream(activationId);
  const events = (await journal.readStream(stream)).map(decodeActivationExecutionEvent);
  await journal.appendToStream(stream, events.length, [
    createActivationExecutionEventData({
      eventId: `${activationId}:released:${runId}`,
      eventType: ExecutionEventType.ActivationReleased,
      occurredAt: clock.now().toISOString(),
      correlationId: activationId,
      causationId: runId,
      actor: { kind: EventActorKind.System, id: 'execution' },
      source: { kind: EventSourceKind.Internal, id: 'execution' },
      payload: { runId },
    }),
  ]);
}

function claimIsUnexpired(
  event: Extract<
    ActivationExecutionEvent['event'],
    { readonly eventType: typeof ExecutionEventType.ActivationClaimed }
  >,
  clock: Clock,
): boolean {
  return new Date(event.payload.expiresAt) > clock.now();
}
