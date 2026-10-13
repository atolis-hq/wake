import {
  EventSourceKind,
  WrongExpectedSequenceError,
  type CommandContext,
  type EventJournal,
} from '@atolis-hq/eventing';
import { createControlPlaneEventData } from '../contracts/event-factory.js';
import {
  TriggerSourceKind,
  type ControlEventPayloads,
  type TriggerSource,
} from '../contracts/events.js';
import { controlPlaneStream, ControlStreamKind } from '../contracts/streams.js';

export type TriggerFactInput = {
  [Type in keyof ControlEventPayloads]: {
    readonly eventType: Type;
    readonly payload: ControlEventPayloads[Type];
  };
}[keyof ControlEventPayloads];

export function sourceIdentity(source: TriggerSource): string {
  return `${source.kind}:${source.kind === TriggerSourceKind.Cron ? source.slot : source.eventId}`;
}

/** Idempotent by event ID; the shared Control Plane stream is re-read on contention. */
export async function appendTriggerFact(
  journal: EventJournal,
  occurredAt: string,
  input: TriggerFactInput,
  context: CommandContext,
  eventId: string,
): Promise<void> {
  const draft = createControlPlaneEventData({
    ...input,
    eventId,
    occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: ControlStreamKind.Global },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const events = await journal.readStream(controlPlaneStream());
    if (events.some((envelope) => envelope.event.eventId === eventId)) return;
    try {
      await journal.appendToStream(controlPlaneStream(), events.length, [draft]);
      return;
    } catch (error) {
      if (!(error instanceof WrongExpectedSequenceError) || attempt === 7) throw error;
    }
  }
}
