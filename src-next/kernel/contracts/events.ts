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

export interface EventDraft<
  Type extends string = string,
  Payload = unknown,
  Stream extends EntityRef = EntityRef,
> {
  readonly eventId: EventId;
  readonly eventType: Type;
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly actor: EventActor;
  readonly source: EventSource;
  readonly stream: Stream;
  readonly payload: Payload;
}

export interface EventEnvelope<
  Type extends string = string,
  Payload = unknown,
  Stream extends EntityRef = EntityRef,
> extends EventDraft<Type, Payload, Stream> {
  readonly recordedAt: string;
  readonly sequence: number;
  readonly globalPosition: number;
}

export type EventUnion<Payloads extends object, Stream extends EntityRef> = {
  [Type in keyof Payloads & string]: EventEnvelope<Type, Payloads[Type], Stream>;
}[keyof Payloads & string];

export type EventDraftUnion<Payloads extends object, Stream extends EntityRef> = {
  [Type in keyof Payloads & string]: EventDraft<Type, Payloads[Type], Stream>;
}[keyof Payloads & string];
