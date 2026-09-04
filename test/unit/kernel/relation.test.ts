import { expect, it } from 'vitest';
import { createRelation, type RelationDefinition } from '../../../src/kernel/index.js';

const definition = {
  owner: 'work',
  name: 'work.related-to',
  fromKind: 'work-item',
  toKind: 'work-item',
} satisfies RelationDefinition<'work.related-to'>;

it('creates a registered relation with matching entity kinds', () => {
  expect(
    createRelation(definition, {
      relationId: 'rel-1',
      from: { kind: 'work-item', id: 'work-1' },
      to: { kind: 'work-item', id: 'work-2' },
      establishedByEventId: 'evt-1',
    }),
  ).toEqual({
    relationId: 'rel-1',
    definition,
    from: { kind: 'work-item', id: 'work-1' },
    to: { kind: 'work-item', id: 'work-2' },
    establishedByEventId: 'evt-1',
  });
});

it('rejects entity kinds that do not match the registered definition', () => {
  expect(() =>
    createRelation(definition, {
      relationId: 'rel-1',
      from: { kind: 'resource', id: 'resource-1' },
      to: { kind: 'work-item', id: 'work-2' },
      establishedByEventId: 'evt-1',
    }),
  ).toThrow('Relation work.related-to requires resource to be work-item');
});
