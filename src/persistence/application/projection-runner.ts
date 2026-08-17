import type {
  CheckpointStore,
  EventEnvelope,
  EventJournal,
  ProjectionDefinition,
  ProjectionStore,
} from '../../kernel/index.js';

export type ProjectionRunSerialiser = <Value>(operation: () => Promise<Value>) => Promise<Value>;

async function runImmediately<Value>(operation: () => Promise<Value>): Promise<Value> {
  return operation();
}

export class ProjectionRunner {
  private caughtUpToGlobalPosition: number | undefined;

  constructor(
    private readonly journal: EventJournal,
    private readonly projections: ProjectionStore,
    private readonly checkpoints: CheckpointStore,
    private readonly registered: readonly ProjectionDefinition[] = [],
    private readonly serialiseRun: ProjectionRunSerialiser = runImmediately,
  ) {}

  // One shared journal read for every registered definition, not one per
  // definition: readAll ultimately re-derives its content-fingerprint via
  // readdir/stat on every call, so fanning that out per-definition costs a
  // full filesystem probe per definition on every tick even when nothing
  // changed. Fetching once and slicing per-checkpoint in memory keeps the
  // same polling cadence at a fraction of the syscall cost.
  //
  // Resident hosts call this on a fast, fixed idle cadence (control-plane
  // never backs off the internal runner loop, only the external poll), so a
  // fully idle system still calls this multiple times a second. Without this
  // short-circuit that means a per-registered-projection checkpoint file
  // read every call forever, even though nothing changed. Only mark a
  // position "caught up" once every definition processed fewer than a full
  // batch — otherwise a backlog bigger than `limit` would get marked caught
  // up after its first (partial) batch and never finish draining.
  async runRegisteredOnce(limit = 100): Promise<number> {
    return this.serialiseRun(() => this.runRegisteredOnceUnlocked(limit));
  }

  private async runRegisteredOnceUnlocked(limit: number): Promise<number> {
    const allEvents = await this.journal.readAll(0);
    const latestGlobalPosition = allEvents.at(-1)?.globalPosition ?? 0;
    if (
      this.caughtUpToGlobalPosition !== undefined &&
      latestGlobalPosition <= this.caughtUpToGlobalPosition
    )
      return 0;
    let failed = false;
    let firstFailure: unknown;
    const counts = await Promise.all(
      this.registered.map(async (definition) => {
        try {
          return await this.applyFrom(definition, allEvents, limit);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstFailure = error;
          }
          return 0;
        }
      }),
    );
    if (failed) throw firstFailure;
    if (counts.every((count) => count < limit))
      this.caughtUpToGlobalPosition = latestGlobalPosition;
    return counts.reduce((total, count) => total + count, 0);
  }

  async runOnce<Value>(definition: ProjectionDefinition<Value>, limit = 100): Promise<number> {
    return this.serialiseRun(() => this.runOnceUnlocked(definition, limit));
  }

  private async runOnceUnlocked<Value>(
    definition: ProjectionDefinition<Value>,
    limit: number,
  ): Promise<number> {
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
    return this.serialiseRun(() => this.rebuildUnlocked(definition));
  }

  private async rebuildUnlocked<Value>(definition: ProjectionDefinition<Value>): Promise<number> {
    await this.projections.clear(definition.name);
    await this.checkpoints.reset(`projection:${definition.name}`);
    let total = 0;
    while (true) {
      const count = await this.runOnceUnlocked(definition, 100);
      total += count;
      if (count < 100) return total;
    }
  }
}
