import type { Clock, EventJournal } from '../../kernel/index.js';
import { defineClosedVocabulary } from '../../kernel/index.js';
import { type EventProcessor } from '../contracts/event-processor.js';

const maximumErrorLength = 1_000;

export const EventProcessorHealthStatus = defineClosedVocabulary({
  Starting: 'starting',
  CatchingUp: 'catching-up',
  Healthy: 'healthy',
  Degraded: 'degraded',
  Stopped: 'stopped',
} as const);

export type EventProcessorHealthStatus =
  (typeof EventProcessorHealthStatus)[keyof typeof EventProcessorHealthStatus];

export interface EventProcessorHealth {
  readonly consumer: string;
  readonly name: string;
  readonly owner: string;
  readonly category: EventProcessor['category'];
  readonly status: EventProcessorHealthStatus;
  readonly checkpoint: number;
  readonly head: number;
  readonly lag: number;
  readonly consecutiveFailures: number;
  readonly lastError?: { readonly name: string; readonly message: string };
  readonly lastAttemptAt?: string;
  readonly lastSuccessAt?: string;
  readonly lastFailureAt?: string;
}

type HealthUpdate = Partial<
  Pick<EventProcessorHealth, 'lastError' | 'lastAttemptAt' | 'lastSuccessAt' | 'lastFailureAt'>
>;

export class ProcessorHealthRegistry {
  private readonly snapshots = new Map<string, EventProcessorHealth>();

  constructor(
    private readonly journal: EventJournal,
    private readonly clock: Clock,
  ) {}

  get(consumer: string): EventProcessorHealth | undefined {
    return this.snapshots.get(consumer);
  }

  async update(
    processor: EventProcessor,
    status: EventProcessorHealthStatus,
    checkpoint: number,
    consecutiveFailures: number,
    update: HealthUpdate = {},
    sampledHead?: number,
  ): Promise<EventProcessorHealth> {
    const head = sampledHead ?? (await this.journal.latestGlobalPosition());
    const health = this.create(processor, status, checkpoint, consecutiveFailures, head, update);
    this.snapshots.set(processor.consumer, health);
    return health;
  }

  async degrade(
    processor: EventProcessor,
    checkpoint: number,
    consecutiveFailures: number,
    error: unknown,
  ): Promise<void> {
    const update = { lastError: boundedError(error), lastFailureAt: this.now() };
    try {
      await this.update(
        processor,
        EventProcessorHealthStatus.Degraded,
        checkpoint,
        consecutiveFailures,
        update,
      );
    } catch {
      const head = this.get(processor.consumer)?.head ?? checkpoint;
      this.snapshots.set(
        processor.consumer,
        this.create(
          processor,
          EventProcessorHealthStatus.Degraded,
          checkpoint,
          consecutiveFailures,
          head,
          update,
        ),
      );
    }
  }

  now(): string {
    return this.clock.now().toISOString();
  }

  private create(
    processor: EventProcessor,
    status: EventProcessorHealthStatus,
    checkpoint: number,
    consecutiveFailures: number,
    head: number,
    update: HealthUpdate,
  ): EventProcessorHealth {
    const previous = this.get(processor.consumer);
    return {
      consumer: processor.consumer,
      name: processor.name,
      owner: processor.owner,
      category: processor.category,
      status,
      checkpoint,
      head,
      lag: Math.max(0, head - checkpoint),
      consecutiveFailures,
      ...(previous?.lastError === undefined ? {} : { lastError: previous.lastError }),
      ...(previous?.lastAttemptAt === undefined ? {} : { lastAttemptAt: previous.lastAttemptAt }),
      ...(previous?.lastSuccessAt === undefined ? {} : { lastSuccessAt: previous.lastSuccessAt }),
      ...(previous?.lastFailureAt === undefined ? {} : { lastFailureAt: previous.lastFailureAt }),
      ...update,
    };
  }
}

function boundedError(error: unknown): { readonly name: string; readonly message: string } {
  if (error instanceof Error)
    return {
      name: error.name.slice(0, maximumErrorLength),
      message: error.message.slice(0, maximumErrorLength),
    };
  return { name: 'Error', message: String(error).slice(0, maximumErrorLength) };
}
