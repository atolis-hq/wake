import type { EventEnvelope } from '../../kernel/index.js';
import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

export const EventProcessorCategory = defineClosedVocabulary({
  Projection: 'projection',
  Reactor: 'reactor',
  Coordinator: 'coordinator',
  Translator: 'translator',
} as const);

export type EventProcessorCategory = ValueOf<typeof EventProcessorCategory>;

export const EventProcessorReplayPolicy = defineClosedVocabulary({
  Rebuildable: 'rebuildable',
  Idempotent: 'idempotent',
  Disabled: 'disabled',
} as const);

export type EventProcessorReplayPolicy = ValueOf<typeof EventProcessorReplayPolicy>;

export interface EventProcessorDefinition<Message> {
  /** Stable checkpoint and serialisation identity. Handlers must be idempotent. */
  readonly consumer: string;
  readonly name: string;
  readonly owner: string;
  readonly category: EventProcessorCategory;
  readonly replayPolicy: EventProcessorReplayPolicy;
  readonly batchSize?: number;
  select(event: EventEnvelope): Message | null;
  handle(message: Message, event: EventEnvelope, signal: AbortSignal): Promise<void>;
}
