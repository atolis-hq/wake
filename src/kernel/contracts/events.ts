import type { CausationId, CorrelationId, EntityRef, EventId } from './identifiers.js';
import { defineClosedVocabulary, type ValueOf } from './vocabulary.js';

export const EventActorKind = defineClosedVocabulary({
  System: 'system',
  Operator: 'operator',
  Agent: 'agent',
  Integration: 'integration',
} as const);

export const EventSourceKind = defineClosedVocabulary({
  Internal: 'internal',
  Adapter: 'adapter',
} as const);

export interface EventActor {
  readonly kind: ValueOf<typeof EventActorKind>;
  readonly id: string;
}

export interface EventSource {
  readonly kind: ValueOf<typeof EventSourceKind>;
  readonly id: string;
}

export interface EventData<Type extends string = string, Payload = unknown> {
  readonly eventId: EventId;
  readonly eventType: Type;
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly actor: EventActor;
  readonly source: EventSource;
  readonly payload: Payload;
}

export interface EventEnvelope<
  Event extends EventData = EventData,
  Stream extends EntityRef = EntityRef,
> {
  readonly event: Event;
  readonly stream: Stream;
  readonly recordedAt: string;
  readonly sequence: number;
  readonly globalPosition: number;
}

export type EventUnion<Payloads extends object, Stream extends EntityRef> = EventEnvelope<
  EventDataUnion<Payloads>,
  Stream
>;

export type EventDataUnion<Payloads extends object> = {
  [Type in keyof Payloads & string]: EventData<Type, Payloads[Type]>;
}[keyof Payloads & string];
