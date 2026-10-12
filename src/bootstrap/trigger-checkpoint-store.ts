import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TriggerCheckpointStore } from '../control-plane/index.js';

/** Durable timestamp cursor for TriggerService; journal checkpoints only store numeric offsets. */
export class FileTriggerCheckpointStore implements TriggerCheckpointStore {
  constructor(private readonly dataRoot: string) {}

  async load(triggerId: string): Promise<string | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path(triggerId), 'utf8')) as {
        triggerId: string;
        slot: string;
      };
      if (parsed.triggerId !== triggerId || Number.isNaN(Date.parse(parsed.slot)))
        throw new Error(`Invalid trigger checkpoint: ${triggerId}`);
      return parsed.slot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(triggerId: string, slot: string): Promise<void> {
    const existing = await this.load(triggerId);
    if (existing !== null && Date.parse(slot) < Date.parse(existing))
      throw new Error(`Trigger checkpoint regression: ${triggerId}`);
    const path = this.path(triggerId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify({ triggerId, slot })}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private path(triggerId: string): string {
    if (triggerId.length === 0 || /[\\/]/.test(triggerId))
      throw new Error('Trigger id must not contain path separators');
    return join(this.dataRoot, 'trigger-checkpoints', `${encodeURIComponent(triggerId)}.json`);
  }
}
