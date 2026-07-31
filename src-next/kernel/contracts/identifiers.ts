export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type EventId = Brand<string, 'EventId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;
export type CausationId = Brand<string, 'CausationId'>;

export interface EntityRef<Kind extends string = string, Id extends string = string> {
  readonly kind: Kind;
  readonly id: Id;
}

export function entityRef<Kind extends string, Id extends string>(
  kind: Kind,
  id: Id,
): EntityRef<Kind, Id> {
  if (id.trim().length === 0) throw new Error('Entity reference id must not be empty');
  return { kind, id };
}

export const eventId = (value: string): EventId => nonEmpty(value, 'event id') as EventId;
export const correlationId = (value: string): CorrelationId =>
  nonEmpty(value, 'correlation id') as CorrelationId;
export const causationId = (value: string): CausationId =>
  nonEmpty(value, 'causation id') as CausationId;

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
  return value;
}
