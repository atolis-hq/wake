import {
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  type EventProcessor,
} from '../contracts/event-processor.js';

export const maximumProcessorBatchSize = 10_000;

export function assertDistinctProcessorConsumers(processors: readonly EventProcessor[]): void {
  const consumers = new Set<string>();
  for (const processor of processors) {
    assertProcessor(processor);
    if (consumers.has(processor.consumer))
      throw new Error(`Processor consumer is already registered: ${processor.consumer}`);
    consumers.add(processor.consumer);
  }
}

export function assertProcessor(processor: EventProcessor): void {
  assertNonEmpty(processor.consumer, 'Processor consumer');
  assertNonEmpty(processor.name, 'Processor name');
  assertNonEmpty(processor.owner, 'Processor owner');
  assertKnown(processor.category, EventProcessorCategory, 'Processor category');
  assertKnown(processor.replayPolicy, EventProcessorReplayPolicy, 'Processor replay policy');
  if (processor.mode !== 'batch' && typeof processor.select !== 'function')
    throw new Error('Processor selector must be a function');
  if (typeof processor.handle !== 'function')
    throw new Error('Processor handler must be a function');
  if (processor.batchSize !== undefined)
    assertPositiveSafeInteger(
      processor.batchSize,
      'Processor batch size',
      maximumProcessorBatchSize,
    );
}

export function assertPositiveSafeInteger(value: number, label: string, maximum?: number): void {
  if (Number.isSafeInteger(value) && value > 0 && (maximum === undefined || value <= maximum))
    return;
  throw new Error(
    `${label} must be a positive safe integer${maximum === undefined ? '' : ` no greater than ${maximum}`}`,
  );
}

export function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (Number.isSafeInteger(value) && value >= 0) return;
  throw new Error(`${label} must be a non-negative safe integer`);
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} must not be empty`);
}

function assertKnown<Value extends string>(
  value: Value,
  vocabulary: Readonly<Record<string, Value>>,
  label: string,
): void {
  if (Object.values(vocabulary).includes(value)) return;
  throw new Error(`${label} must be recognized`);
}
