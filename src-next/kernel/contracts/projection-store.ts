import type { EventEnvelope } from './events.js';
export interface StoredProjection<Value = unknown> {
  readonly namespace: string;
  readonly key: string;
  readonly lastGlobalPosition: number;
  readonly value: Value;
}
export interface ProjectionStore {
  read<Value>(namespace: string, key: string): Promise<StoredProjection<Value> | null>;
  write<Value>(projection: StoredProjection<Value>): Promise<void>;
  list<Value>(namespace: string): Promise<readonly StoredProjection<Value>[]>;
  clear(namespace?: string): Promise<void>;
}
export interface ProjectionDefinition<Value = unknown> {
  readonly name: string;
  select(event: EventEnvelope): { readonly key: string } | null;
  initial(key: string): Value;
  project(previous: Value, event: EventEnvelope): Value;
}
