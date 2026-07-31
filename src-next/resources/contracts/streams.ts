import type { EntityRef } from '../../kernel/index.js';
import type { ResourceId } from './identifiers.js';

export const ResourceStreamKind = { Resource: 'resource' } as const;

export type ResourceStreamRef = EntityRef<typeof ResourceStreamKind.Resource, ResourceId>;

export const resourceStream = (id: ResourceId): ResourceStreamRef => ({
  kind: ResourceStreamKind.Resource,
  id,
});

export const isResourceStream = (stream: EntityRef): stream is ResourceStreamRef =>
  stream.kind === ResourceStreamKind.Resource;
