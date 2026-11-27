import type {
  ResourceCorrelationView,
  ResourceService,
  ResourceView,
} from '../../src/resources/index.js';
import type { WorkItemId, WorkService } from '../../src/work/index.js';

/** Synchronous stand-ins for the snapshots the label reconciler reads in memory. */
export function fakeWork(
  get: (id: WorkItemId) => { readonly state: string; readonly deleted?: boolean } | null,
  invalid: (id: WorkItemId) => boolean = () => false,
): Pick<WorkService, 'deliverySnapshot'> {
  return {
    deliverySnapshot: async () =>
      ({
        get: (id: WorkItemId) => get(id),
        invalid: (id: WorkItemId) => invalid(id),
        availability: () => ({ rootWorkItemId: '' }),
      }) as never,
  };
}

export function fakeResources(source: {
  readonly correlations: (resourceId: never) => readonly ResourceCorrelationView[];
  readonly correlationsForWork: (workItemId: never) => readonly ResourceCorrelationView[];
  readonly get: (resourceId: never) => ResourceView | null;
}): Pick<ResourceService, 'correlationSnapshot'> {
  return {
    correlationSnapshot: async () => ({
      correlations: (id) => source.correlations(id as never),
      correlationsForWork: (id) => source.correlationsForWork(id as never),
      externalKey: (id) => source.get(id as never)?.externalKey ?? null,
    }),
  };
}
