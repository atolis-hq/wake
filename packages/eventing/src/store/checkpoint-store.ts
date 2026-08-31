export interface CheckpointStore {
  load(consumer: string): Promise<number>;
  save(consumer: string, globalPosition: number): Promise<void>;
  reset(consumer: string): Promise<void>;
}
