import type { CommandContext } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { ResourceId } from './identifiers.js';
import type { ExternalResourceKey, ResourceCapability } from './views.js';

export interface DiscoverResource {
  readonly resourceId: ResourceId;
  readonly kind: string;
  readonly externalKey: ExternalResourceKey;
  readonly capabilities: readonly ResourceCapability[];
  readonly revision?: string;
}

export interface ObserveResourceRevision {
  readonly resourceId: ResourceId;
  readonly revision: string;
}

export interface CorrelateResourceToWork {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly role: 'primary' | 'secondary';
  readonly context: CommandContext;
}
