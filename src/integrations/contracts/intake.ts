import type { EventDraft } from '../../kernel/index.js';
import type { IntegrationStreamRef } from './streams.js';

export type ProviderEventDraft = EventDraft<string, unknown, IntegrationStreamRef>;

export interface ExternalEventSource {
  poll(signal: AbortSignal): Promise<readonly ProviderEventDraft[]>;
}

export interface InboundTranslation {
  /** Resolves to the count of inbound events processed this pass, so callers can tell activity from a quiet checkpoint. */
  runOnce(limit?: number): Promise<number>;
}
