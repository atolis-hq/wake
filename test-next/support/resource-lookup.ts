import type { EventJournal } from '../../src-next/kernel/index.js';
import { InMemoryProjectionStore } from '../../src-next/persistence/index.js';
import { createResourceLookup, createResourceService } from '../../src-next/resources/index.js';

export function createTestResourceServices(journal: EventJournal) {
  const lookup = createResourceLookup({
    journal,
    projections: new InMemoryProjectionStore(),
  });
  return { lookup, resources: createResourceService(journal, lookup) };
}
