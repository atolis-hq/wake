import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ScheduleCheckpointStore } from '../control-plane/index.js';

/** Durable timestamp cursor for ScheduleService; journal checkpoints only store numeric offsets. */
export class FileScheduleCheckpointStore implements ScheduleCheckpointStore {
  constructor(private readonly dataRoot: string) {}

  async load(scheduleId: string): Promise<string | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path(scheduleId), 'utf8')) as {
        scheduleId: string;
        slot: string;
      };
      if (parsed.scheduleId !== scheduleId || Number.isNaN(Date.parse(parsed.slot)))
        throw new Error(`Invalid schedule checkpoint: ${scheduleId}`);
      return parsed.slot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(scheduleId: string, slot: string): Promise<void> {
    const existing = await this.load(scheduleId);
    if (existing !== null && Date.parse(slot) < Date.parse(existing))
      throw new Error(`Schedule checkpoint regression: ${scheduleId}`);
    const path = this.path(scheduleId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify({ scheduleId, slot })}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private path(scheduleId: string): string {
    if (scheduleId.length === 0 || /[\\/]/.test(scheduleId))
      throw new Error('Schedule id must not contain path separators');
    return join(this.dataRoot, 'schedule-checkpoints', `${encodeURIComponent(scheduleId)}.json`);
  }
}
