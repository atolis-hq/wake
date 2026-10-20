import type { EventEnvelope } from '../contracts/events.js';
import type { ProcessorRunSerialiser } from '../runtime/processor-run-serialiser.js';
import type { CheckpointStore } from '../store/checkpoint-store.js';
import type { EventJournal } from '../store/event-journal.js';
import {
  defineEventProcessor,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  type EventProcessor,
} from '../subscriptions/event-processor.js';
import type { ProjectionDefinition, ProjectionStore } from './projection-store.js';

const projectionBatchSize = 100;

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

const catchUpBatchSize = 500;

/**
 * Reads one projected key with read-your-writes consistency: the stored value
 * plus any events the projection processor has not applied yet. The tail starts
 * at the processor's checkpoint, not the key's own last position: everything at
 * or below the checkpoint is already applied for every key, whereas a quiet
 * key's position can trail the head by the whole history.
 */
export async function readCurrentProjection<Value>(
  dependencies: {
    readonly journal: Pick<EventJournal, 'readAll'>;
    readonly projections: ProjectionStore;
    readonly checkpoints: Pick<CheckpointStore, 'load'>;
  },
  definition: ProjectionDefinition<Value>,
  key: string,
): Promise<Value> {
  const stored = await dependencies.projections.read<Value>(definition.name, key);
  let value = stored?.value ?? definition.initial(key);
  let position = Math.max(
    stored?.lastGlobalPosition ?? 0,
    await dependencies.checkpoints.load(projectionConsumer(definition)),
  );
  for (;;) {
    const events = await dependencies.journal.readAll(position, catchUpBatchSize);
    for (const event of events)
      if (definition.select(event)?.key === key) value = definition.project(value, event);
    if (events.length < catchUpBatchSize) return value;
    position = events.at(-1)!.globalPosition;
  }
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
