import type { RelationDefinition } from '../../kernel/index.js';

export const resourceRepresentsWork = {
  owner: 'resources',
  name: 'resources.represents-work',
  fromKind: 'resource',
  toKind: 'work-item',
} as const satisfies RelationDefinition<'resources.represents-work'>;
