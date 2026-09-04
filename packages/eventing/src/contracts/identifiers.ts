type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type EventId = Brand<string, 'EventId'>;

export type CorrelationId = Brand<string, 'CorrelationId'>;

export type CausationId = Brand<string, 'CausationId'>;

export const eventId = (value: string): EventId => nonEmpty(value, 'event id') as EventId;

export const correlationId = (value: string): CorrelationId =>
  nonEmpty(value, 'correlation id') as CorrelationId;

export const causationId = (value: string): CausationId =>
  nonEmpty(value, 'causation id') as CausationId;

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
  return value;
}
