import { collectionResponse, decodeCursor, encodeCursor } from '../contracts/index.js';
import type { ApiHttpResponse } from '../http-server.js';
import type { ApiCollectionPage, CollectionQuery } from './applications.js';
import { invalidQuery, ok } from './responses.js';

export function parseCollectionQuery(
  parameters: URLSearchParams,
  allowed: ReadonlySet<string>,
): CollectionQuery | ApiHttpResponse {
  const invalidParameter = validateParameterNames(parameters, allowed);
  if (invalidParameter !== undefined) return invalidParameter;
  const limit = parseLimit(parameters.get('limit'));
  if (typeof limit !== 'number') return limit;
  const cursor = parseCursor(parameters.get('cursor'));
  if ('status' in cursor) return cursor;
  const text = parseTextFilters(parameters);
  return 'status' in text
    ? text
    : queryResult(
        limit,
        cursor.value,
        text.search,
        text.state,
        parameters.get('workItemKey') ?? undefined,
      );
}

export function collection<T>(page: ApiCollectionPage<T>, query: CollectionQuery): ApiHttpResponse {
  const visible = page.items.slice(0, query.limit);
  const hasMore = page.nextPosition !== undefined || page.items.length > query.limit;
  const nextPosition =
    page.continuationPosition ??
    page.nextPosition ??
    (hasMore ? (query.cursor?.position ?? 0) + visible.length : undefined);
  return ok(
    collectionResponse(
      visible,
      page.meta.asOf,
      {
        nextCursor: nextPosition === undefined ? null : encodeCursor({ position: nextPosition }),
        hasMore,
        ...(page.total === undefined ? {} : { total: page.total }),
      },
      page.meta.position,
    ),
  );
}

export function normalizePage<T>(result: ApiCollectionPage<T>): ApiCollectionPage<T> {
  return result;
}

function validateParameterNames(
  parameters: URLSearchParams,
  allowed: ReadonlySet<string>,
): ApiHttpResponse | undefined {
  for (const key of parameters.keys()) {
    if (!allowed.has(key)) return invalidQuery(`Unknown query parameter: ${key}`, key);
    if (parameters.getAll(key).length !== 1)
      return invalidQuery(`Query parameter must occur once: ${key}`, key);
  }
  return undefined;
}

function parseLimit(value: string | null): number | ApiHttpResponse {
  const limit = value === null ? 50 : Number(value);
  return /^[1-9]\d*$/.test(value ?? '50') && Number.isSafeInteger(limit) && limit <= 200
    ? limit
    : invalidQuery('limit must be an integer from 1 to 200', 'limit');
}

function parseCursor(
  value: string | null,
): { readonly value?: CollectionQuery['cursor'] } | ApiHttpResponse {
  if (value === null) return {};
  try {
    return { value: decodeCursor(value) };
  } catch {
    return invalidQuery('cursor is malformed or unsupported', 'cursor');
  }
}

function parseTextFilters(
  parameters: URLSearchParams,
): Pick<CollectionQuery, 'search' | 'state'> | ApiHttpResponse {
  const search = parameters.get('search')?.trim();
  if (search !== undefined && search.length > 200)
    return invalidQuery('search must be at most 200 characters', 'search');
  const state = parameters.get('state')?.trim();
  if (state !== undefined && (state === '' || state.length > 100))
    return invalidQuery('state must be a non-empty value of at most 100 characters', 'state');
  return {
    ...(search === undefined || search === '' ? {} : { search }),
    ...(state === undefined ? {} : { state }),
  };
}

function queryResult(
  limit: number,
  cursor: CollectionQuery['cursor'],
  search?: string,
  state?: string,
  workItemKey?: string,
): CollectionQuery {
  return {
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    ...(search === undefined ? {} : { search }),
    ...(state === undefined ? {} : { state }),
    ...(workItemKey === undefined ? {} : { workItemKey }),
  };
}
