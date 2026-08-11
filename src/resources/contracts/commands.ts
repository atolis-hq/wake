import type { CommandContext } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { ResourceCapability, ResourceId, ResourceKind } from './identifiers.js';
import type { ExternalResourceKey } from './views.js';
import type { ResourceCorrelationRole } from './vocabulary.js';

export interface DiscoverResource {
  readonly resourceId: ResourceId;
  readonly kind: ResourceKind;
  readonly externalKey: ExternalResourceKey;
  readonly capabilities: readonly ResourceCapability[];
  readonly revision?: string;
  readonly title?: string;
}

export interface ObserveResourceRevision {
  readonly resourceId: ResourceId;
  readonly revision: string;
}

export interface CorrelateResourceToWork {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly role: ResourceCorrelationRole;
  readonly context: CommandContext;
}
