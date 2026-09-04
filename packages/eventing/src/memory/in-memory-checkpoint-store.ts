import type { CheckpointStore } from '../store/checkpoint-store.js';

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly values = new Map<string, number>();
  async load(consumer: string): Promise<number> {
    return this.values.get(consumer) ?? 0;
  }

  async save(consumer: string, position: number): Promise<void> {
    if (position < (await this.load(consumer)))
      throw new Error(`Checkpoint regression for ${consumer}`);
    this.values.set(consumer, position);
  }

  async reset(consumer: string): Promise<void> {
    this.values.delete(consumer);
  }
}
