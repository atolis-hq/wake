/** HTTP transport contracts shared by all Wake API capabilities. */
export interface ResponseMeta {
  readonly asOf: string;
  readonly position?: number;
}

export interface ResourceResponse<T> {
  readonly data: T;
  readonly meta: ResponseMeta;
}

export interface CollectionResponse<T> {
  readonly items: readonly T[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly total?: number;
  };
  readonly meta: ResponseMeta;
}

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly [extension: string]: unknown;
}

export interface WakeProblemDetails extends ProblemDetails {
  readonly code?: string;
  readonly retryable?: boolean;
  readonly current?: unknown;
  readonly violations?: readonly { readonly path: string; readonly message: string }[];
}

export interface CursorPosition {
  readonly position: number;
}

export function encodeCursor(value: CursorPosition): string {
  if (!Number.isSafeInteger(value.position) || value.position < 0)
    throw new Error('Invalid cursor position');
  return `c_${btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

export function decodeCursor(value: string): CursorPosition {
  if (!/^c_[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid cursor');
  try {
    const encoded = value.slice(2).replaceAll('-', '+').replaceAll('_', '/');
    const parsed: unknown = JSON.parse(
      atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')),
    );
    if (typeof parsed !== 'object' || parsed === null || !('position' in parsed)) throw new Error();
    const position = (parsed as { readonly position?: unknown }).position;
    if (!Number.isSafeInteger(position) || (position as number) < 0) throw new Error();
    return { position: position as number };
  } catch {
    throw new Error('Invalid cursor');
  }
}

export function resourceResponse<T>(data: T, asOf: string, position?: number): ResourceResponse<T> {
  assertUtcInstant(asOf);
  return { data, meta: position === undefined ? { asOf } : { asOf, position } };
}

export function collectionResponse<T>(
  items: readonly T[],
  asOf: string,
  page: Partial<CollectionResponse<T>['page']> = {},
  position?: number,
): CollectionResponse<T> {
  assertUtcInstant(asOf);
  return {
    items,
    page: {
      nextCursor: page.nextCursor ?? null,
      hasMore: page.hasMore ?? false,
      ...(page.total === undefined ? {} : { total: page.total }),
    },
    meta: position === undefined ? { asOf } : { asOf, position },
  };
}

function assertUtcInstant(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error('Response timestamps must be valid UTC RFC 3339 instants ending in Z');
}

export function workItemPath(workItemKey: string): string {
  return `/api/v1/work-items/${encodeURIComponent(workItemKey)}`;
}
