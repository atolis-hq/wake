import type { EventEnvelope } from '../contracts/events.js';
import type { EventProcessor } from '../subscriptions/event-processor.js';

/** Preserves the original stack as cause and attributes only known event context. */
export class EventProcessorFailure extends Error {
  readonly consumer: string;
  readonly eventId?: string;
  readonly globalPosition?: number;

  constructor(
    processor: Pick<EventProcessor, 'name' | 'consumer'>,
    cause: unknown,
    event?: EventEnvelope,
  ) {
    super(
      `Processor ${processor.name} (${processor.consumer}) failed${event === undefined ? '' : ` on event ${event.event.eventId} at global position ${event.globalPosition}`}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'EventProcessorFailure';
    this.consumer = processor.consumer;
    if (event !== undefined) {
      this.eventId = event.event.eventId;
      this.globalPosition = event.globalPosition;
    }
  }
}
