import type { EventProcessor } from '../../eventing/index.js';
import type { EventDraft } from '../../kernel/index.js';
import type { IntegrationStreamRef } from './streams.js';

export type ProviderEventDraft = EventDraft<string, unknown, IntegrationStreamRef>;

export interface ExternalEventSource {
  poll(signal: AbortSignal): Promise<readonly ProviderEventDraft[]>;
  /** Commits provider cursor state after every draft from the poll is durable. */
  markPollPersisted?(): Promise<void>;
}

export interface InboundTranslation {
  /** Stable adapter-specific definition hosted by the shared Eventing runtime. */
  readonly processor: EventProcessor;
}

export interface ProviderReconciler {
  /** Provider recovery stays in the maintenance lane, outside incremental event handling. */
  reconcileOnce(): Promise<void>;
}
