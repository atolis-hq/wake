import type { EventJournal } from '../../src/kernel/index.js';
import { InMemoryProjectionStore } from '../../src/persistence/index.js';
import { createResourceLookup, createResourceService } from '../../src/resources/index.js';

export function createTestResourceServices(journal: EventJournal) {
  const lookup = createResourceLookup({
    journal,
    projections: new InMemoryProjectionStore(),
  });
  return { lookup, resources: createResourceService(journal, lookup) };
}
