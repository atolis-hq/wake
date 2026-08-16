import type { EventDraft } from '../../kernel/index.js';
import type { IntegrationStreamRef } from './streams.js';

export type ProviderEventDraft = EventDraft<string, unknown, IntegrationStreamRef>;

export interface ExternalEventSource {
  poll(signal: AbortSignal): Promise<readonly ProviderEventDraft[]>;
  /** Commits provider cursor state after every draft from the poll is durable. */
  markPollPersisted?(): Promise<void>;
}

export interface InboundTranslation {
  /** Resolves to the count of inbound events processed this pass, so callers can tell activity from a quiet checkpoint. */
  runOnce(limit?: number): Promise<number>;
}
