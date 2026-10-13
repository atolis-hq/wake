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
import { triggerControlStream, triggerInvocationStream } from '../contracts/streams.js';

export type TriggerFactInput = {
  [Type in keyof ControlEventPayloads]: {
    readonly eventType: Type;
    readonly payload: ControlEventPayloads[Type];
  };
}[keyof ControlEventPayloads];

export function sourceIdentity(source: TriggerSource): string {
  return `${source.kind}:${source.kind === TriggerSourceKind.Cron ? source.slot : source.eventId}`;
}

/** Invocation/command appends check event IDs; source appends use the caught-up scope sequence. */
export async function appendTriggerFact(
  journal: EventJournal,
  occurredAt: string,
  input: TriggerFactInput,
  context: CommandContext,
  eventId: string,
  sequence?: number,
): Promise<void> {
  if (!('coordinationKey' in input.payload)) throw new Error('Expected trigger fact');
  const stream =
    'workItemId' in input.payload
      ? triggerInvocationStream(input.payload.workItemId)
      : triggerControlStream(input.payload.coordinationKey);
  const draft = createControlPlaneEventData({
    ...input,
    eventId,
    occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: stream.kind },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const events = sequence === undefined ? await journal.readStream(stream) : null;
    if (events?.some((envelope) => envelope.event.eventId === eventId)) return;
    try {
      await journal.appendToStream(stream, sequence ?? events!.length, [draft]);
      return;
    } catch (error) {
      if (!(error instanceof WrongExpectedSequenceError) || attempt === 7) throw error;
      sequence = undefined;
    }
  }
}
