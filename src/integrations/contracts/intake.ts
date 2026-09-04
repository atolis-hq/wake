import type { EventData, EventProcessor } from '@atolis-hq/eventing';

export type ProviderEventData = EventData<string, unknown>;

export interface ExternalEventSource {
  poll(signal: AbortSignal): Promise<readonly ProviderEventData[]>;
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
