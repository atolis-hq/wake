import type { RelationDefinition } from '../../kernel/index.js';
import { WorkStreamKind } from '../../work/index.js';
import { ResourceStreamKind } from '../contracts/streams.js';

export const resourceRepresentsWork = {
  owner: 'resources',
  name: 'resources.represents-work',
  fromKind: ResourceStreamKind.Resource,
  toKind: WorkStreamKind.WorkItem,
} as const satisfies RelationDefinition<'resources.represents-work'>;
