import type { EntityRef } from '../contracts/identifiers.js';
import type { Relation, RelationDefinition } from '../contracts/relations.js';

export interface RelationInput {
  readonly relationId: string;
  readonly from: EntityRef;
  readonly to: EntityRef;
  readonly establishedByEventId: string;
}

export function createRelation<Name extends string>(
  definition: RelationDefinition<Name>,
  input: RelationInput,
): Relation<Name> {
  assertKind(definition.name, input.from.kind, definition.fromKind);
  assertKind(definition.name, input.to.kind, definition.toKind);
  return { ...input, definition };
}

function assertKind(relationName: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`Relation ${relationName} requires ${actual} to be ${expected}`);
  }
}
