import type { WorkItemId } from '../../work/index.js';
import type { ResourceCapability, ResourceId, ResourceKind } from './identifiers.js';
import type {
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
  ResourceExternalOutcome,
} from './vocabulary.js';

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
  readonly title?: string;
  readonly primaryCorrelationConflict?: {
    readonly attemptedWorkItemId: WorkItemId;
    readonly existingWorkItemId: WorkItemId;
    readonly eventId: string;
  };
  readonly correlationStatus?: 'unresolvable';
  readonly pendingExternalOutcome?: {
    readonly sourceObservationId: string;
    readonly outcome: ResourceExternalOutcome;
    readonly revision: string;
  };
}

export type ResourceLinkResolver = (externalKey: ExternalResourceKey) => string | null;

export interface ResourceCorrelationView {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly role: ResourceCorrelationRole;
  readonly provenance: ResourceCorrelationProvenance;
  readonly establishedByEventId: string;
}
