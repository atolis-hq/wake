import type { EventJournal, StoredProjection } from '@atolis-hq/eventing';
import type { ResponseMeta } from '../surfaces/index.js';

export function sampledMeta(asOf: string): ResponseMeta {
  return { asOf };
}

export async function projectionMeta(
  journal: EventJournal,
  projections: readonly Pick<StoredProjection, 'lastGlobalPosition'>[],
  emptyAsOf: string,
): Promise<ResponseMeta> {
  const position = projections.reduce(
    (latest, projection) => Math.max(latest, projection.lastGlobalPosition),
    0,
  );
  if (position === 0) return sampledMeta(emptyAsOf);
  const event = (await journal.readAll(position - 1, 1))[0];
  if (event === undefined || event.globalPosition !== position)
    throw new Error(`Journal fact unavailable for projection position ${position}`);
  return { asOf: event.event.occurredAt, position };
}
