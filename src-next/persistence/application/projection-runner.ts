import type {
  CheckpointStore,
  EventEnvelope,
  EventJournal,
  ProjectionDefinition,
  ProjectionStore,
} from '../../kernel/index.js';

export class ProjectionRunner {
  constructor(
    private readonly journal: EventJournal,
    private readonly projections: ProjectionStore,
    private readonly checkpoints: CheckpointStore,
    private readonly registered: readonly ProjectionDefinition[] = [],
  ) {}

  // One shared journal read for every registered definition, not one per
  // definition: readAll ultimately re-derives its content-fingerprint via
  // readdir/stat on every call, so fanning that out per-definition costs a
  // full filesystem probe per definition on every tick even when nothing
  // changed. Fetching once and slicing per-checkpoint in memory keeps the
  // same polling cadence at a fraction of the syscall cost.
  async runRegisteredOnce(limit = 100): Promise<number> {
    const allEvents = await this.journal.readAll(0);
    const counts = await Promise.all(
      this.registered.map((definition) => this.applyFrom(definition, allEvents, limit)),
    );
    return counts.reduce((total, count) => total + count, 0);
  }

  async runOnce<Value>(definition: ProjectionDefinition<Value>, limit = 100): Promise<number> {
    const consumer = `projection:${definition.name}`;
    const events = await this.journal.readAll(await this.checkpoints.load(consumer), limit);
    return this.apply(definition, consumer, events);
  }

  private async applyFrom<Value>(
    definition: ProjectionDefinition<Value>,
    allEvents: readonly EventEnvelope[],
    limit: number,
  ): Promise<number> {
    const consumer = `projection:${definition.name}`;
    const checkpoint = await this.checkpoints.load(consumer);
    const events = allEvents.filter((event) => event.globalPosition > checkpoint).slice(0, limit);
    return this.apply(definition, consumer, events);
  }

  private async apply<Value>(
    definition: ProjectionDefinition<Value>,
    consumer: string,
    events: readonly EventEnvelope[],
  ): Promise<number> {
    for (const event of events) {
      const selected = definition.select(event);
      if (selected !== null) {
        const previous = await this.projections.read<Value>(definition.name, selected.key);
        if ((previous?.lastGlobalPosition ?? 0) < event.globalPosition) {
          await this.projections.write({
            namespace: definition.name,
            key: selected.key,
            lastGlobalPosition: event.globalPosition,
            value: definition.project(previous?.value ?? definition.initial(selected.key), event),
          });
        }
      }
      await this.checkpoints.save(consumer, event.globalPosition);
    }
    return events.length;
  }

  async rebuild<Value>(definition: ProjectionDefinition<Value>): Promise<number> {
    await this.projections.clear(definition.name);
    await this.checkpoints.reset(`projection:${definition.name}`);
    let total = 0;
    while (true) {
      const count = await this.runOnce(definition);
      total += count;
      if (count < 100) return total;
    }
  }
}
