import type { ActivationId } from '../../activities/index.js';
import {
  createEventDraft,
  EventActorKind,
  EventSourceKind,
  type Clock,
  type EventJournal,
} from '../../kernel/index.js';
import type { ExecutionConfig } from '../contracts/config.js';
import type { RunId } from '../contracts/identifiers.js';
import { activationStream } from '../contracts/streams.js';

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
  const events = await journal.readStream(stream);
  const last = events.at(-1);
  if (last?.eventType === 'execution.activation-claimed' && unexpired(last.payload, clock))
    throw new Error(`Activation ${activationId} already has an active Run claim`);
  await journal.append(stream, events.length, [
    createEventDraft({
      eventId: `${activationId}:claim:${runId}`,
      eventType: 'execution.activation-claimed',
      occurredAt,
      correlationId: activationId,
      causationId: runId,
      actor: { kind: EventActorKind.System, id: owner },
      source: { kind: EventSourceKind.Internal, id: 'execution' },
      stream,
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
  const events = await journal.readStream(stream);
  await journal.append(stream, events.length, [
    createEventDraft({
      eventId: `${activationId}:released:${runId}`,
      eventType: 'execution.activation-released',
      occurredAt: clock.now().toISOString(),
      correlationId: activationId,
      causationId: runId,
      actor: { kind: EventActorKind.System, id: 'execution' },
      source: { kind: EventSourceKind.Internal, id: 'execution' },
      stream,
      payload: { runId },
    }),
  ]);
}

function unexpired(payload: unknown, clock: Clock): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const expiresAt = Reflect.get(payload, 'expiresAt');
  return typeof expiresAt === 'string' && new Date(expiresAt) > clock.now();
}
