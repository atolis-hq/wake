import type { EntityRef } from './identifiers.js';

export interface RelationDefinition<Name extends string = string> {
  readonly owner: string;
  readonly name: Name;
  readonly fromKind: string;
  readonly toKind: string;
}

export interface Relation<Name extends string = string> {
  readonly relationId: string;
  readonly definition: RelationDefinition<Name>;
  readonly from: EntityRef;
  readonly to: EntityRef;
  readonly establishedByEventId: string;
}
