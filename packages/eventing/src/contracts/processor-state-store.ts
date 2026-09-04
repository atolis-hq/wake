export interface StoredProcessorState<Value = unknown> {
  readonly consumer: string;
  readonly key: string;
  readonly value: Value;
}

export interface ProcessorStateStore {
  read<Value>(consumer: string, key: string): Promise<StoredProcessorState<Value> | null>;
  write<Value>(state: StoredProcessorState<Value>): Promise<void>;
  delete(consumer: string, key: string): Promise<void>;
}
