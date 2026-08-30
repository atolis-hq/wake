import type {
  CheckpointStore,
  EventEnvelope,
  EventJournal,
  ProjectionDefinition,
  ProjectionStore,
} from '../../kernel/index.js';
import {
  defineEventProcessor,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  type EventProcessor,
} from '../contracts/event-processor.js';
import type { ProcessorRunSerialiser } from '../contracts/processor-run-serialiser.js';

const projectionBatchSize = 100;

interface ProjectionMessage {
  readonly key: string;
}

export function projectionConsumer<Value>(definition: ProjectionDefinition<Value>): string {
  return `projection:${definition.name}`;
}

export function createProjectionProcessor<Value>(
  definition: ProjectionDefinition<Value>,
  projections: ProjectionStore,
): EventProcessor {
  return defineEventProcessor({
    consumer: projectionConsumer(definition),
    name: definition.name,
    owner: EventProcessorCategory.Projection,
    category: EventProcessorCategory.Projection,
    replayPolicy: EventProcessorReplayPolicy.Rebuildable,
    batchSize: projectionBatchSize,
    select: (event) => definition.select(event),
    handle: (selected, event) => applyProjectionEvent(definition, projections, selected.key, event),
  });
}

export async function applyProjectionEvent<Value>(
  definition: ProjectionDefinition<Value>,
  projections: ProjectionStore,
  key: string,
  event: EventEnvelope,
): Promise<void> {
  const previous = await projections.read<Value>(definition.name, key);
  if ((previous?.lastGlobalPosition ?? 0) >= event.globalPosition) return;
  await projections.write({
    namespace: definition.name,
    key,
    lastGlobalPosition: event.globalPosition,
    value: definition.project(previous?.value ?? definition.initial(key), event),
  });
}

export async function applyProjectionBatch<Value>(
  definition: ProjectionDefinition<Value>,
  projections: ProjectionStore,
  events: readonly EventEnvelope[],
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  throwIfAborted(signal);
  const processor = createProjectionProcessor(definition, projections);
  if (processor.mode === 'batch') throw new Error('Projection processors must handle each event');
  for (const event of events) {
    throwIfAborted(signal);
    const selected = processor.select(event);
    if (selected !== null) await processor.handle(selected, event, signal);
  }
}

export class ProjectionRebuilder {
  constructor(
    private readonly journal: EventJournal,
    private readonly projections: ProjectionStore,
    private readonly checkpoints: CheckpointStore,
    private readonly serialiseRun: ProcessorRunSerialiser,
  ) {}

  rebuild<Value>(definition: ProjectionDefinition<Value>, signal?: AbortSignal): Promise<number> {
    return this.serialiseRun(
      projectionConsumer(definition),
      signal ?? new AbortController().signal,
      () => this.rebuildLocked(definition, signal ?? new AbortController().signal),
    );
  }

  private async rebuildLocked<Value>(
    definition: ProjectionDefinition<Value>,
    signal: AbortSignal,
  ): Promise<number> {
    const consumer = projectionConsumer(definition);
    await this.projections.clear(definition.name);
    await this.checkpoints.reset(consumer);
    const processor = createProjectionProcessor(definition, this.projections);
    if (processor.mode === 'batch') throw new Error('Projection processors must handle each event');
    let total = 0;
    while (true) {
      throwIfAborted(signal);
      const checkpoint = await this.checkpoints.load(consumer);
      const events = await this.journal.readAll(checkpoint, projectionBatchSize);
      if (events.length === 0) return total;
      for (const event of events) {
        throwIfAborted(signal);
        const message = processor.select(event);
        if (message !== null) await processor.handle(message, event, signal);
      }
      await this.checkpoints.save(consumer, events.at(-1)!.globalPosition);
      total += events.length;
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Projection rebuild aborted');
}
