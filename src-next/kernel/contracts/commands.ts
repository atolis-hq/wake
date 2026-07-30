import type { CorrelationId } from './identifiers.js';
import type { EventActor } from './events.js';

export interface CommandContext {
  readonly commandId: string;
  readonly correlationId: CorrelationId;
  readonly actor: EventActor;
  readonly occurredAt: string;
}
