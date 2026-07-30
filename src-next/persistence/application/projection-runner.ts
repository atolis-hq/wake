import type {
  CheckpointStore,
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
  async runRegisteredOnce(limit = 100): Promise<number> {
    const counts = await Promise.all(
      this.registered.map((definition) => this.runOnce(definition, limit)),
    );
    return counts.reduce((total, count) => total + count, 0);
  }
  async runOnce<Value>(definition: ProjectionDefinition<Value>, limit = 100): Promise<number> {
    const consumer = `projection:${definition.name}`;
    const events = await this.journal.readAll(await this.checkpoints.load(consumer), limit);
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
