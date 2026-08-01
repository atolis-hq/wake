import type { EventDraft } from '../../kernel/index.js';
import type { IntegrationStreamRef } from './streams.js';

export type ProviderEventDraft = EventDraft<string, unknown, IntegrationStreamRef>;

export interface ExternalEventSource {
  poll(signal: AbortSignal): Promise<readonly ProviderEventDraft[]>;
}

export interface InboundTranslation {
  runOnce(limit?: number): Promise<void>;
}
