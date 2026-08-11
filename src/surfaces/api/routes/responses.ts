import {
  resourceResponse,
  type ApiCommandResult,
  type ResourceResponse,
} from '../contracts/index.js';
import type { ApiHttpResponse } from '../http-server.js';
import { problemDetails } from '../problem-details.js';

export async function noQuery(
  url: URL,
  operation: () => Promise<ApiHttpResponse> | ApiHttpResponse,
): Promise<ApiHttpResponse> {
  return url.search === ''
    ? operation()
    : invalidQuery('This resource does not accept query parameters');
}

export function decodePathSegment(value: string): string | ApiPathError {
  try {
    return decodeURIComponent(value);
  } catch {
    return new ApiPathError('The route contains malformed percent encoding');
  }
}

export class ApiPathError extends Error {}

export function accepted(value: ApiCommandResult, asOf: string, status = 202): ApiHttpResponse {
  if ('conflict' in value)
    return problem(409, 'Conflict', value.detail ?? 'The command conflicts with current state', {
      code: value.code,
      retryable: value.retryable ?? false,
      ...(value.current === undefined ? {} : { current: value.current }),
    });
  return {
    status,
    body: resourceResponse(value, 'acceptedAt' in value ? value.acceptedAt : asOf),
  };
}

export function ok(body: unknown): ApiHttpResponse {
  return { status: 200, body };
}

export function found<T>(value: ResourceResponse<T> | undefined): ApiHttpResponse {
  return value === undefined ? problem(404, 'Not Found', 'Resource not found') : ok(value);
}

export function unavailable(commandName: string, current?: unknown): ApiHttpResponse {
  return problem(409, 'Conflict', `The ${commandName} capability is unavailable`, {
    code: 'command-unavailable',
    retryable: false,
    ...(current === undefined ? {} : { current }),
  });
}

export function invalidPath(detail: string): ApiHttpResponse {
  return problem(400, 'Bad Request', detail, { code: 'invalid-path' });
}

export function invalidQuery(detail: string, path = ''): ApiHttpResponse {
  return problem(422, 'Unprocessable Content', detail, {
    code: 'invalid-query',
    violations: [{ path, message: detail }],
  });
}

export function invalidRequest(path: string, message: string): ApiHttpResponse {
  return problem(422, 'Unprocessable Content', 'The command request is invalid', {
    code: 'invalid-request',
    violations: [{ path, message }],
  });
}

export function problem(
  status: number,
  title: string,
  detail: string,
  extensions: Record<string, unknown> = {},
): ApiHttpResponse {
  return {
    status,
    body: problemDetails(status, title, detail, extensions),
    contentType: 'application/problem+json',
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
