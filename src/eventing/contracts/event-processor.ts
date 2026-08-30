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
  readonly mode?: 'event';
  readonly select: (event: EventEnvelope) => Message | null;
  readonly handle: (message: Message, event: EventEnvelope, signal: AbortSignal) => Promise<void>;
}

export interface BatchEventProcessorDefinition {
  readonly consumer: string;
  readonly name: string;
  readonly owner: string;
  readonly category: EventProcessorCategory;
  readonly replayPolicy: EventProcessorReplayPolicy;
  readonly batchSize?: number;
  readonly mode: 'batch';
  readonly handle: (events: readonly EventEnvelope[], signal: AbortSignal) => Promise<void>;
}

// The runtime carries heterogeneous processors; typed construction remains at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const registeredEventProcessor: unique symbol;

/** An opaque runtime registration; obtain it only through the factories below. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RegisteredEventProcessor = EventProcessorDefinition<any> & {
  readonly [registeredEventProcessor]: true;
};

type RegisteredBatchEventProcessor = BatchEventProcessorDefinition & {
  readonly [registeredEventProcessor]: true;
};

export type EventProcessor = RegisteredEventProcessor | RegisteredBatchEventProcessor;

export function defineEventProcessor<Message>(
  definition: EventProcessorDefinition<Message>,
): EventProcessor {
  return definition as unknown as EventProcessor;
}

export function createBatchEventProcessor(
  definition: Omit<BatchEventProcessorDefinition, 'mode'>,
): EventProcessor {
  return { ...definition, mode: 'batch' } as unknown as EventProcessor;
}
