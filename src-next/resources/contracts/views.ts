import type { WorkItemId } from '../../work/index.js';
import type { ResourceId } from './identifiers.js';

export type ResourceCapability =
  'commentable' | 'reviewable' | 'approvable' | 'mergeable' | 'revisioned' | 'editable';

export interface ExternalResourceKey {
  readonly adapter: string;
  readonly key: string;
}

export interface ResourceView {
  readonly resourceId: ResourceId;
  readonly kind: string;
  readonly externalKey: ExternalResourceKey;
  readonly capabilities: readonly ResourceCapability[];
  readonly revision?: string;
}

export interface ResourceCorrelationView {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly role: 'primary' | 'secondary';
  readonly establishedByEventId: string;
}
