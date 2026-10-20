import type { EventJournal } from '@atolis-hq/eventing';
import { InMemoryCheckpointStore, InMemoryProjectionStore } from '@atolis-hq/eventing/memory';
import { createResourceLookup, createResourceService } from '../../src/resources/index.js';

export function createTestResourceServices(journal: EventJournal) {
  const lookup = createResourceLookup({
    journal,
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
  });
  return { lookup, resources: createResourceService(journal, lookup) };
}
