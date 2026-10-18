import type { CheckpointStore, EventJournal, EventProcessorFailure } from '@atolis-hq/eventing';
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
import { inspect } from 'node:util';

/**
 * Logs the full stack when a processor first fails or its failure changes;
 * identical repeats log one short line only at each power-of-ten count so a
 * poison event retried on backoff cannot flood the log.
 */
export function createProcessorFailureLogger(
  write: (line: string) => void,
): (error: EventProcessorFailure) => void {
  const seen = new Map<string, { message: string; count: number }>();
  return (error) => {
    const previous = seen.get(error.consumer);
    if (previous?.message !== error.message) {
      seen.set(error.consumer, { message: error.message, count: 1 });
      write(`${inspect(error, { depth: 8 })}\n`);
      return;
    }
    previous.count += 1;
    if (Number.isInteger(Math.log10(previous.count)))
      write(`${error.message} (repeated ${previous.count} times; stack logged on first failure)\n`);
  };
}

/**
 * Bootstrap's single registry for every deployed event processor. It owns
 * runtime supervision only; processor definitions remain with their modules.
 */
export class EventProcessorRuntime {
  private readonly host: EventProcessorHost;
  private readonly registrations = new Map<string, EventProcessor>();
  private registrationsClosed = false;
  private activeRun: EventProcessorHostRun | undefined;

  constructor(
    private readonly journal: EventJournal,
    private readonly checkpoints: CheckpointStore,
    serialiseRun: ProcessorRunSerialiser,
    clock: EventingClock,
    options: EventProcessorHostOptions = {},
  ) {
    this.host = new EventProcessorHost(journal, checkpoints, serialiseRun, clock, {
      onFailure: createProcessorFailureLogger((line) => process.stderr.write(line)),
      ...options,
    });
  }

  get processors(): readonly EventProcessor[] {
    return [...this.registrations.values()];
  }

  register(processors: readonly EventProcessor[]): void {
    if (this.registrationsClosed) throw new Error('Event processor registry has already started');
    const consumers = new Set<string>();
    for (const processor of processors) {
      if (this.registrations.has(processor.consumer) || consumers.has(processor.consumer))
        throw new Error(`Event processor is already registered: ${processor.consumer}`);
      consumers.add(processor.consumer);
    }
    for (const processor of processors) {
      this.registrations.set(processor.consumer, processor);
    }
  }

  start(signal?: AbortSignal): EventProcessorHostRun {
    if (this.activeRun !== undefined) return this.activeRun;
    this.registrationsClosed = true;
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
    const results = await Promise.allSettled(
      processors.map(async (processor) => {
        try {
          const checkpoint = await this.checkpoints.load(processor.consumer);
          if (
            checkpoint >= targetGlobalPosition &&
            this.host.health(processor.consumer)?.status !== EventProcessorHealthStatus.Degraded
          )
            return { checkpoint, eventCount: 0, handledCount: 0 };
        } catch {
          // Let the host attribute and supervise storage failures.
        }
        return this.host.runThrough(processor, targetGlobalPosition, signal);
      }),
    );
    const failures = results.flatMap((result) =>
      result.status !== 'fulfilled' ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `${name}: ${failures.map((error: unknown) => (error instanceof Error ? error.message : String(error))).join('; ')}`,
      );
    return results.reduce(
      (total, result) => total + (result.status === 'fulfilled' ? result.value.eventCount : 0),
      0,
    );
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
