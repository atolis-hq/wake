import type { ProcessorStateStore } from '@atolis-hq/eventing';
import { z } from 'zod';
import type { TriggerCheckpointStore } from '../control-plane/index.js';

const cursorSchema = z.object({ slot: z.string().datetime({ offset: true }) }).strict();

/** Cron watermarks are processor recovery state, separate from rebuildable projections. */
export class ProcessorTriggerCheckpointStore implements TriggerCheckpointStore {
  constructor(private readonly state: ProcessorStateStore) {}
  async load(triggerId: string): Promise<string | null> {
    const stored = await this.state.read(`reactor:control-plane.trigger:${triggerId}`, 'cron');
    return stored === null ? null : cursorSchema.parse(stored.value).slot;
  }

  async save(triggerId: string, slot: string): Promise<void> {
    const value = cursorSchema.parse({ slot });
    const existing = await this.load(triggerId);
    if (existing !== null && Date.parse(slot) < Date.parse(existing))
      throw new Error(`Trigger checkpoint regression: ${triggerId}`);
    await this.state.write({
      consumer: `reactor:control-plane.trigger:${triggerId}`,
      key: 'cron',
      value,
    });
  }
}
