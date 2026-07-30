import {
  createEventDraft,
  entityRef,
  type Clock,
  type EventEnvelope,
  type IdGenerator,
} from '../../../src-next/kernel/index.js';
import { InMemoryEventJournal } from '../../../src-next/persistence/index.js';
import { FaultInjector } from './faults.js';
import { formatTrace } from './trace.js';

export class FakeClock implements Clock {
  private current = new Date('2026-07-30T12:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export class SequentialIds implements IdGenerator {
  private nextValue = 1;

  next(prefix: string): string {
    return `${prefix}-${this.nextValue++}`;
  }
}

export class TestWorld {
  readonly clock = new FakeClock();
  readonly ids = new SequentialIds();
  readonly faults = new FaultInjector();
  readonly journal = new InMemoryEventJournal(this.clock);
  private readonly stream = entityRef('test', 'scenario');

  async appendFact<Type extends string, Payload>(
    eventType: Type,
    payload: Payload,
    cause: string,
  ): Promise<EventEnvelope<Type, Payload>> {
    const currentEvents = await this.journal.readStream(this.stream);
    const [appended] = await this.journal.append(this.stream, currentEvents.length, [
      createEventDraft({
        eventId: this.ids.next('event'),
        eventType,
        occurredAt: this.clock.now().toISOString(),
        correlationId: 'scenario-1',
        causationId: cause,
        actor: { kind: 'system', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        stream: this.stream,
        payload,
      }),
    ]);
    if (appended === undefined) throw new Error('Scenario fact was not appended');
    return appended as EventEnvelope<Type, Payload>;
  }

  async trace(): Promise<string> {
    return formatTrace(await this.journal.readAll(0));
  }
}
