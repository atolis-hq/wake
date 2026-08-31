import type { CausationId, CorrelationId, EventId } from './identifiers.js';

export const EventActorKind = {
  System: 'system',
  Operator: 'operator',
  Agent: 'agent',
  Integration: 'integration',
} as const;

export const EventSourceKind = {
  Internal: 'internal',
  Adapter: 'adapter',
} as const;

export interface StreamRef<Kind extends string = string, Id extends string = string> {
  readonly kind: Kind;
  readonly id: Id;
}

export interface EventActor {
  readonly kind: (typeof EventActorKind)[keyof typeof EventActorKind];
  readonly id: string;
}

export interface EventSource {
  readonly kind: (typeof EventSourceKind)[keyof typeof EventSourceKind];
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
  Stream extends StreamRef = StreamRef,
> {
  readonly event: Event;
  readonly stream: Stream;
  readonly recordedAt: string;
  readonly sequence: number;
  readonly globalPosition: number;
}

export type EventUnion<Payloads extends object, Stream extends StreamRef> = EventEnvelope<
  EventDataUnion<Payloads>,
  Stream
>;

export type EventDataUnion<Payloads extends object> = {
  [Type in keyof Payloads & string]: EventData<Type, Payloads[Type]>;
}[keyof Payloads & string];
