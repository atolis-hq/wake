import type { EventEnvelope, ProcessorStateStore } from '@atolis-hq/eventing';
import { z } from 'zod';
import { TriggerSourceKind, type TriggerSource } from '../contracts/events.js';

export interface TriggerCheckpointStore {
  load(triggerId: string): Promise<string | null>;
  save(triggerId: string, slot: string): Promise<void>;
}

const sourceCursorSchema = z.object({ position: z.number().int().nonnegative() }).strict();

/** Consumed occurrences are processor recovery cursors, not an ever-growing request history. */
export class TriggerSourceCursor {
  constructor(
    private readonly dependencies: {
      readonly checkpoint: TriggerCheckpointStore;
      readonly state: ProcessorStateStore;
    },
  ) {}

  async isConsumed(
    triggerId: string,
    source: TriggerSource,
    event?: EventEnvelope,
  ): Promise<boolean> {
    if (source.kind === TriggerSourceKind.Cron) {
      const previous = await this.dependencies.checkpoint.load(triggerId);
      if (previous !== null && Date.parse(source.slot) <= Date.parse(previous)) return true;
    }
    if (source.kind === TriggerSourceKind.Event) {
      if (event === undefined || event.event.eventId !== source.eventId)
        throw new Error('Event trigger requests require their canonical source envelope');
      const stored = await this.dependencies.state.read(
        `reactor:control-plane.trigger:${triggerId}`,
        'source',
      );
      if (
        stored !== null &&
        event.globalPosition <= sourceCursorSchema.parse(stored.value).position
      )
        return true;
    }
    return false;
  }

  async consume(triggerId: string, source: TriggerSource, event?: EventEnvelope): Promise<void> {
    if (source.kind !== TriggerSourceKind.Event || event === undefined) return;
    await this.dependencies.state.write({
      consumer: `reactor:control-plane.trigger:${triggerId}`,
      key: 'source',
      value: { position: event.globalPosition },
    });
  }
}
