import type { ResourceIndex } from '../../core/contracts.js';

/**
 * In-memory ResourceIndex test fake. Permanent test harness (per repo
 * convention: fakes are passed on purpose, never a default that materializes
 * when a caller forgets to wire one in), not a fallback baked into core/.
 * Production always uses the disk-backed `createResourceIndex` from
 * `src/adapters/fs/resource-index.ts`.
 */
export function createFakeResourceIndex(): ResourceIndex {
  const entries = new Map<string, string>();
  return {
    async resolve(resourceUri: string) {
      return entries.get(resourceUri);
    },
    async register(resourceUri: string, workItemKey: string) {
      entries.set(resourceUri, workItemKey);
    },
    async retract(resourceUri: string) {
      entries.delete(resourceUri);
    },
  };
}
