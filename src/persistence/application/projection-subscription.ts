import type {
  CheckpointStore,
  EventEnvelope,
  EventJournal,
  ProjectionDefinition,
  ProjectionStore,
} from '../../kernel/index.js';
import type { DurableSubscription } from './durable-subscription-host.js';
import type { SubscriptionRunSerialiser } from './subscription-run-serialiser.js';

const projectionBatchSize = 100;

export function projectionConsumer<Value>(definition: ProjectionDefinition<Value>): string {
  return `projection:${definition.name}`;
}

export function createProjectionSubscription<Value>(
  definition: ProjectionDefinition<Value>,
  projections: ProjectionStore,
): DurableSubscription {
  return {
    consumer: projectionConsumer(definition),
    batchSize: projectionBatchSize,
    handle: (events) => applyProjectionBatch(definition, projections, events),
  };
}

export async function applyProjectionBatch<Value>(
  definition: ProjectionDefinition<Value>,
  projections: ProjectionStore,
  events: readonly EventEnvelope[],
): Promise<void> {
  for (const event of events) {
    const selected = definition.select(event);
    if (selected === null) continue;
    const previous = await projections.read<Value>(definition.name, selected.key);
    if ((previous?.lastGlobalPosition ?? 0) >= event.globalPosition) continue;
    await projections.write({
      namespace: definition.name,
      key: selected.key,
      lastGlobalPosition: event.globalPosition,
      value: definition.project(previous?.value ?? definition.initial(selected.key), event),
    });
  }
}

export class ProjectionRebuilder {
  constructor(
    private readonly journal: EventJournal,
    private readonly projections: ProjectionStore,
    private readonly checkpoints: CheckpointStore,
    private readonly serialiseRun: SubscriptionRunSerialiser,
  ) {}

  rebuild<Value>(definition: ProjectionDefinition<Value>, signal?: AbortSignal): Promise<number> {
    return this.serialiseRun(
      projectionConsumer(definition),
      signal ?? new AbortController().signal,
      () => this.rebuildLocked(definition),
    );
  }

  private async rebuildLocked<Value>(definition: ProjectionDefinition<Value>): Promise<number> {
    const consumer = projectionConsumer(definition);
    await this.projections.clear(definition.name);
    await this.checkpoints.reset(consumer);
    let total = 0;
    while (true) {
      const checkpoint = await this.checkpoints.load(consumer);
      const events = await this.journal.readAll(checkpoint, projectionBatchSize);
      if (events.length === 0) return total;
      await applyProjectionBatch(definition, this.projections, events);
      await this.checkpoints.save(consumer, events.at(-1)!.globalPosition);
      total += events.length;
    }
  }
}
