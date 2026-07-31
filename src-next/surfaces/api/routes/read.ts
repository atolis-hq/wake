import type { ApiHttpResponse } from '../http-server.js';
import type { ApiApplications, CollectionQuery } from './applications.js';
import { collection, parseCollectionQuery } from './pagination.js';
import {
  ApiPathError,
  decodePathSegment,
  found,
  invalidPath,
  invalidQuery,
  noQuery,
  ok,
  unavailable,
} from './responses.js';

const collectionRoutes = new Map<string, ReadonlySet<string>>([
  ['/api/v1/work-items', new Set(['cursor', 'limit', 'search', 'state'])],
  ['/api/v1/resources', new Set(['cursor', 'limit'])],
  ['/api/v1/workflow-instances', new Set(['cursor', 'limit', 'state'])],
  ['/api/v1/runs', new Set(['cursor', 'limit', 'state'])],
  ['/api/v1/runners', new Set(['cursor', 'limit'])],
  ['/api/v1/events', new Set(['cursor', 'limit'])],
]);

export async function dispatchRead(
  applications: ApiApplications,
  method: string,
  url: URL,
): Promise<ApiHttpResponse | undefined> {
  if (method !== 'GET' && method !== 'HEAD') return undefined;
  const resource = await readSingleton(applications, url);
  if (resource !== undefined) return resource;
  const page = await readCollection(applications, url);
  if (page !== undefined) return page;
  if (url.search !== '') return invalidQuery('This resource does not accept query parameters');
  return readDetail(applications, url.pathname);
}

async function readSingleton(
  applications: ApiApplications,
  url: URL,
): Promise<ApiHttpResponse | undefined> {
  switch (url.pathname) {
    case '/api/v1/control-plane/status':
      return noQuery(url, async () => ok(await applications.controlPlane.status()));
    case '/api/v1/observability/metrics':
      return noQuery(url, async () => ok(await applications.observability.metrics()));
    case '/api/v1/system/health':
      return noQuery(url, async () => ok(await applications.system.health()));
    case '/api/v1/system/configuration':
      return noQuery(url, async () => ok(await applications.system.configuration()));
    default:
      return undefined;
  }
}

async function readCollection(
  applications: ApiApplications,
  url: URL,
): Promise<ApiHttpResponse | undefined> {
  const allowed = collectionRoutes.get(url.pathname);
  if (allowed === undefined) return undefined;
  const query = parseCollectionQuery(url.searchParams, allowed);
  if ('status' in query) return query;
  return collectionResult(applications, url.pathname, query);
}

async function collectionResult(
  applications: ApiApplications,
  pathname: string,
  query: CollectionQuery,
): Promise<ApiHttpResponse> {
  switch (pathname) {
    case '/api/v1/work-items':
      return collection(await applications.work.list(query), query);
    case '/api/v1/resources':
      return collection(await applications.resources.list(query), query);
    case '/api/v1/workflow-instances':
      return collection(await applications.orchestration.list(query), query);
    case '/api/v1/runs':
      return collection(await applications.execution.list(query), query);
    case '/api/v1/runners':
      return applications.execution.runners === undefined
        ? unavailable('runners')
        : collection(await applications.execution.runners(query), query);
    default:
      return collection(await applications.events.list(query), query);
  }
}

async function readDetail(
  applications: ApiApplications,
  pathname: string,
): Promise<ApiHttpResponse | undefined> {
  const transcript = /^\/api\/v1\/runs\/([^/]+)\/transcript$/.exec(pathname)?.[1];
  if (transcript !== undefined) return readTranscript(applications, transcript);
  const work = /^\/api\/v1\/work-items\/([^/]+)$/.exec(pathname)?.[1];
  if (work !== undefined) return readWork(applications, work);
  const run = /^\/api\/v1\/runs\/([^/]+)$/.exec(pathname)?.[1];
  return run === undefined ? undefined : readRun(applications, run);
}

async function readTranscript(applications: ApiApplications, segment: string) {
  const runId = decodePathSegment(segment);
  if (runId instanceof ApiPathError) return invalidPath(runId.message);
  if (applications.execution.transcript === undefined)
    return unavailable('transcript', await applications.execution.get?.(runId));
  return found(await applications.execution.transcript(runId));
}

async function readWork(applications: ApiApplications, segment: string) {
  const key = decodePathSegment(segment);
  return key instanceof ApiPathError
    ? invalidPath(key.message)
    : found(await applications.work.detail(key));
}

async function readRun(applications: ApiApplications, segment: string) {
  const runId = decodePathSegment(segment);
  return runId instanceof ApiPathError
    ? invalidPath(runId.message)
    : found(await applications.execution.get?.(runId));
}
