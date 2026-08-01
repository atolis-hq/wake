import type { WorkItemId } from '../../work/index.js';
import type { ResourceCapability, ResourceId, ResourceKind } from './identifiers.js';
import type { ResourceCorrelationRole } from './vocabulary.js';

export type { ResourceCapability, ResourceKind } from './identifiers.js';

export interface ExternalResourceKey {
  readonly adapter: string;
  readonly key: string;
}

export interface ResourceView {
  readonly resourceId: ResourceId;
  readonly kind: ResourceKind;
  readonly externalKey: ExternalResourceKey;
  readonly capabilities: readonly ResourceCapability[];
  readonly revision?: string;
  readonly primaryCorrelationConflict?: {
    readonly attemptedWorkItemId: WorkItemId;
    readonly existingWorkItemId: WorkItemId;
    readonly eventId: string;
  };
}

export interface ResourceCorrelationView {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly role: ResourceCorrelationRole;
  readonly establishedByEventId: string;
}
