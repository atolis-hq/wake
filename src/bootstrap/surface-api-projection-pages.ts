import type { EventJournal, StoredProjection } from '@atolis-hq/eventing';
import type { ApiCollectionPage, CollectionQuery, ResponseMeta } from '../surfaces/index.js';
import { projectionMeta } from './surface-api-metadata.js';

interface PositionedValue<Value> {
  readonly lastGlobalPosition: number;
  readonly value: Value;
}

interface ProjectionPageOptions {
  readonly emptyAsOf: string;
  readonly provenance?: readonly Pick<StoredProjection, 'lastGlobalPosition'>[];
}

export async function projectionPage<Value, Dto>(
  journal: EventJournal,
  values: readonly PositionedValue<Value>[],
  query: CollectionQuery,
  present: (value: Value) => Dto,
  options: ProjectionPageOptions,
): Promise<ApiCollectionPage<Dto>> {
  const provenance = options.provenance ?? values;
  const after = query.cursor?.position ?? Number.POSITIVE_INFINITY;
  const candidates = [...values]
    .filter((entry) => entry.lastGlobalPosition < after)
    .sort((left, right) => right.lastGlobalPosition - left.lastGlobalPosition);
  const visible = candidates.slice(0, query.limit);
  const last = visible.at(-1);
  const metaSources: readonly Pick<StoredProjection, 'lastGlobalPosition'>[] =
    provenance.length === 0 && query.cursor !== undefined
      ? [{ lastGlobalPosition: query.cursor.position }]
      : provenance;
  const meta: ResponseMeta = await projectionMeta(journal, metaSources, options.emptyAsOf);
  return {
    items: visible.map((entry) => present(entry.value)),
    meta,
    total: values.length,
    ...(candidates.length > query.limit && last !== undefined
      ? { nextPosition: last.lastGlobalPosition }
      : {}),
  };
}
