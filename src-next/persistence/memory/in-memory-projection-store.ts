import type { ProjectionStore, StoredProjection } from '../../kernel/index.js';

export class InMemoryProjectionStore implements ProjectionStore {
  private readonly values = new Map<string, StoredProjection>();
  async read<Value>(namespace: string, key: string): Promise<StoredProjection<Value> | null> {
    return (this.values.get(`${namespace}\0${key}`) as StoredProjection<Value> | undefined) ?? null;
  }

  async write<Value>(projection: StoredProjection<Value>): Promise<void> {
    this.values.set(`${projection.namespace}\0${projection.key}`, structuredClone(projection));
  }

  async list<Value>(namespace: string): Promise<readonly StoredProjection<Value>[]> {
    return [...this.values.values()].filter(
      (value) => value.namespace === namespace,
    ) as StoredProjection<Value>[];
  }

  async clear(namespace?: string): Promise<void> {
    for (const [key, value] of this.values)
      if (namespace === undefined || value.namespace === namespace) this.values.delete(key);
  }
}
