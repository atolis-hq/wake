import type { CausationId, CorrelationId, EntityRef, EventId } from './identifiers.js';

export interface EventActor {
  readonly kind: 'system' | 'operator' | 'agent' | 'integration';
  readonly id: string;
}

export interface EventSource {
  readonly kind: 'internal' | 'adapter';
  readonly id: string;
}

export interface EventDraft<Type extends string = string, Payload = unknown> {
  readonly eventId: EventId;
  readonly eventType: Type;
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly actor: EventActor;
  readonly source: EventSource;
  readonly stream: EntityRef;
  readonly payload: Payload;
}

export interface EventEnvelope<Type extends string = string, Payload = unknown> extends EventDraft<
  Type,
  Payload
> {
  readonly recordedAt: string;
  readonly sequence: number;
  readonly globalPosition: number;
}
