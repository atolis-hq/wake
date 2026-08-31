import type { CheckpointStore, EventJournal } from '@atolis-hq/eventing';
import {
  EventProcessorHealthStatus,
  EventProcessorHost,
  type EventProcessor,
  type EventProcessorHealth,
  type EventProcessorHostOptions,
  type EventProcessorHostRun,
  type EventingClock,
  type ProcessorRunSerialiser,
} from '@atolis-hq/eventing';

/**
 * Bootstrap's single registry for every deployed event processor. It owns
 * runtime supervision only; processor definitions remain with their modules.
 */
export class EventProcessorRuntime {
  private readonly host: EventProcessorHost;
  private readonly registrations = new Map<string, EventProcessor>();
  private activeRun: EventProcessorHostRun | undefined;

  constructor(
    private readonly journal: EventJournal,
    private readonly checkpoints: CheckpointStore,
    serialiseRun: ProcessorRunSerialiser,
    clock: EventingClock,
    options: EventProcessorHostOptions = {},
  ) {
    this.host = new EventProcessorHost(journal, checkpoints, serialiseRun, clock, options);
  }

  get processors(): readonly EventProcessor[] {
    return [...this.registrations.values()];
  }

  register(processors: readonly EventProcessor[]): void {
    for (const processor of processors) {
      if (this.registrations.has(processor.consumer))
        throw new Error(`Event processor is already registered: ${processor.consumer}`);
      this.registrations.set(processor.consumer, processor);
    }
  }

  start(signal?: AbortSignal): EventProcessorHostRun {
    if (this.activeRun !== undefined) return this.activeRun;
    const run = this.host.start(this.processors, signal);
    const activeRun: EventProcessorHostRun = {
      abort: () => run.abort(),
      done: run.done.finally(() => {
        if (this.activeRun === activeRun) this.activeRun = undefined;
      }),
    };
    this.activeRun = activeRun;
    return activeRun;
  }

  async catchUp(
    name: string,
    processors: readonly EventProcessor[] = this.processors,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.catchUpThrough(name, await this.journal.latestGlobalPosition(), processors, signal);
  }

  async catchUpThrough(
    name: string,
    targetGlobalPosition: number,
    processors: readonly EventProcessor[] = this.processors,
    signal?: AbortSignal,
  ): Promise<number> {
    if (name.trim().length === 0) throw new Error('Event processor barrier name is required');
    for (const processor of processors) this.assertRegistered(processor);
    const pending = (
      await Promise.all(
        processors.map(async (processor) => ({
          processor,
          checkpoint: await this.checkpoints.load(processor.consumer),
        })),
      )
    ).filter(({ checkpoint }) => checkpoint < targetGlobalPosition);
    const passes = await Promise.all(
      pending.map(({ processor }) => this.host.runThrough(processor, targetGlobalPosition, signal)),
    );
    return passes.reduce((total, pass) => total + pass.eventCount, 0);
  }

  async health(): Promise<readonly EventProcessorHealth[]> {
    const head = await this.journal.latestGlobalPosition();
    return Promise.all(
      this.processors.map(async (processor) => {
        const snapshot = this.host.health(processor.consumer);
        if (snapshot !== undefined) return snapshot;
        const checkpoint = await this.checkpoints.load(processor.consumer);
        return {
          consumer: processor.consumer,
          name: processor.name,
          owner: processor.owner,
          category: processor.category,
          status: EventProcessorHealthStatus.Starting,
          checkpoint,
          head,
          lag: Math.max(0, head - checkpoint),
          consecutiveFailures: 0,
        };
      }),
    );
  }

  private assertRegistered(processor: EventProcessor): void {
    if (this.registrations.get(processor.consumer) !== processor)
      throw new Error(`Event processor is not registered: ${processor.consumer}`);
  }
}
