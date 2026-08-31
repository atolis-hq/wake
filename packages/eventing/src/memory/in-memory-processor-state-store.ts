import type {
  ProcessorStateStore,
  StoredProcessorState,
} from '../contracts/processor-state-store.js';

export class InMemoryProcessorStateStore implements ProcessorStateStore {
  private readonly values = new Map<string, Map<string, StoredProcessorState>>();

  async read<Value>(consumer: string, key: string): Promise<StoredProcessorState<Value> | null> {
    const state = this.values.get(consumer)?.get(key);
    return state === undefined ? null : (structuredClone(state) as StoredProcessorState<Value>);
  }

  async write<Value>(state: StoredProcessorState<Value>): Promise<void> {
    const states = this.values.get(state.consumer) ?? new Map<string, StoredProcessorState>();
    states.set(state.key, structuredClone(state));
    this.values.set(state.consumer, states);
  }

  async delete(consumer: string, key: string): Promise<void> {
    const states = this.values.get(consumer);
    if (states === undefined) return;
    states.delete(key);
    if (states.size === 0) this.values.delete(consumer);
  }
}
