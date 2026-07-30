import type { EventEnvelope } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { ExternalResourceKey, ResourceCapability } from './views.js';
import type { ResourceId } from './identifiers.js';

export type ResourceEvent =
  | EventEnvelope<
      'resources.resource-discovered',
      {
        kind: string;
        externalKey: ExternalResourceKey;
        capabilities: readonly ResourceCapability[];
        revision?: string;
      }
    >
  | EventEnvelope<'resources.resource-revision-observed', { revision: string }>
  | EventEnvelope<
      'resources.work-correlation-established',
      {
        workItemId: WorkItemId;
        role: 'primary' | 'secondary';
      }
    >
  | EventEnvelope<'resources.work-correlation-retracted', { workItemId: WorkItemId }>
  | EventEnvelope<
      'resources.work-correlation-conflicted',
      {
        workItemId: WorkItemId;
        existingWorkItemId: WorkItemId;
      }
    >;

export interface ResourceEventStream {
  readonly resourceId: ResourceId;
  readonly events: readonly ResourceEvent[];
}
