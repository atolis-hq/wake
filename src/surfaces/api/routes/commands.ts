import type { RunnerResponse } from '../contracts/index.js';
import type { ApiHttpResponse } from '../http-server.js';
import type {
  ApiApplications,
  ApiCommandRequest,
  ApiRunResolutionRequest,
} from './applications.js';
import { normalizePage } from './pagination.js';
import {
  accepted,
  ApiPathError,
  decodePathSegment,
  invalidPath,
  invalidQuery,
  invalidRequest,
  isObject,
  problem,
  unavailable,
} from './responses.js';

type WorkCommandName = 'freeze' | 'unfreeze' | 'delete' | 'retry';

type ControlCommandName = 'pause' | 'resume' | 'tick';

export async function dispatchCommand(
  applications: ApiApplications,
  url: URL,
  body: unknown,
): Promise<ApiHttpResponse> {
  if (url.search !== '') return invalidQuery('Command routes do not accept query parameters');
  const ambiguityResolution = await dispatchAmbiguousRunResolution(
    applications,
    url.pathname,
    body,
  );
  if (ambiguityResolution !== undefined) return ambiguityResolution;
  const request = commandRequest(body);
  if (isHttpResponse(request)) return request;
  const work = await dispatchWorkCommand(applications, url.pathname, request);
  if (work !== undefined) return work;
  const control = await dispatchControlCommand(applications, url.pathname, request);
  if (control !== undefined) return control;
  const runner = await dispatchRunnerCommand(applications, url.pathname, request);
  return runner ?? problem(404, 'Not Found', `No command route for ${url.pathname}`);
}

async function dispatchAmbiguousRunResolution(
  applications: ApiApplications,
  pathname: string,
  body: unknown,
): Promise<ApiHttpResponse | undefined> {
  const match = /^\/api\/v1\/runs\/([^/]+)\/commands\/resolve$/.exec(pathname);
  if (match === null) return undefined;
  const runId = decodePathSegment(match[1]!);
  if (runId instanceof ApiPathError) return invalidPath(runId.message);
  const request = runResolutionRequest(body);
  if (isHttpResponse(request)) return request;
  const operation = applications.execution.resolveAmbiguousRun;
  if (operation === undefined)
    return unavailable('resolve-ambiguous-run', await applications.execution.get?.(runId));
  return accepted(await operation(runId, request), applications.now());
}

async function dispatchWorkCommand(
  applications: ApiApplications,
  pathname: string,
  request: ApiCommandRequest,
): Promise<ApiHttpResponse | undefined> {
  const match = /^\/api\/v1\/work-items\/([^/]+)\/commands\/(freeze|unfreeze|delete|retry)$/.exec(
    pathname,
  );
  if (match === null) return undefined;
  const decoded = decodePathSegment(match[1]!);
  if (decoded instanceof ApiPathError) return invalidPath(decoded.message);
  const name = match[2]! as WorkCommandName;
  const operation = applications.work[name];
  if (operation === undefined)
    return unavailable(name, (await applications.work.detail(decoded))?.data);
  const status = name === 'freeze' || name === 'unfreeze' ? 200 : 202;
  return accepted(await operation(decoded, request), applications.now(), status);
}

async function dispatchControlCommand(
  applications: ApiApplications,
  pathname: string,
  request: ApiCommandRequest,
): Promise<ApiHttpResponse | undefined> {
  const name = controlCommandName(pathname);
  if (name === undefined) return undefined;
  const status = await applications.controlPlane.status();
  if (name === 'tick' && status.data.paused)
    return problem(409, 'Conflict', 'Ticks are paused', { code: 'paused', current: status.data });
  const operation = applications.controlPlane[name];
  return operation === undefined
    ? unavailable(name, status.data)
    : accepted(await operation(request), applications.now());
}

function controlCommandName(pathname: string): ControlCommandName | undefined {
  const prefix = '/api/v1/control-plane/commands/';
  if (!pathname.startsWith(prefix)) return undefined;
  const name = pathname.slice(prefix.length);
  return name === 'pause' || name === 'resume' || name === 'tick' ? name : undefined;
}

async function dispatchRunnerCommand(
  applications: ApiApplications,
  pathname: string,
  request: ApiCommandRequest,
): Promise<ApiHttpResponse | undefined> {
  const match = /^\/api\/v1\/runners\/([^/]+)\/commands\/(pause|unpause)$/.exec(pathname);
  if (match === null) return undefined;
  const runnerId = decodePathSegment(match[1]!);
  if (runnerId instanceof ApiPathError) return invalidPath(runnerId.message);
  const operation =
    match[2] === 'pause'
      ? applications.execution.pauseRunner
      : applications.execution.unpauseRunner;
  if (operation !== undefined)
    return accepted(await operation(runnerId, request), applications.now());
  return unavailable(`runner-${match[2]}`, await currentRunner(applications, runnerId));
}

async function currentRunner(
  applications: ApiApplications,
  runnerId: string,
): Promise<RunnerResponse | undefined> {
  if (applications.execution.runners === undefined) return undefined;
  const page = normalizePage(await applications.execution.runners({ limit: 200 }));
  return page.items.find((item) => item.runnerId === runnerId);
}

function commandRequest(body: unknown): ApiCommandRequest | ApiHttpResponse {
  if (!isObject(body))
    return invalidRequest('idempotencyKey', 'A JSON object with an idempotency key is required');
  if (Object.keys(body).some((key) => key !== 'idempotencyKey'))
    return invalidRequest('', 'The command body contains unknown fields');
  const value = body.idempotencyKey;
  if (typeof value !== 'string' || value.trim() === '')
    return invalidRequest('idempotencyKey', 'Must be a non-empty string');
  return value.length <= 200
    ? { idempotencyKey: value }
    : invalidRequest('idempotencyKey', 'Must be at most 200 characters');
}

function runResolutionRequest(body: unknown): ApiRunResolutionRequest | ApiHttpResponse {
  if (!isObject(body))
    return invalidRequest('idempotencyKey', 'A JSON object with an idempotency key is required');
  const idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '')
    return invalidRequest('idempotencyKey', 'Must be a non-empty string');
  if (idempotencyKey.length > 200)
    return invalidRequest('idempotencyKey', 'Must be at most 200 characters');
  if (body.status === 'succeeded') {
    if (
      Object.keys(body).some(
        (key) => key !== 'idempotencyKey' && key !== 'status' && key !== 'outcome',
      )
    )
      return invalidRequest('', 'The command body contains unknown fields');
    if (!Object.hasOwn(body, 'outcome'))
      return invalidRequest('outcome', 'Is required for success');
    return { idempotencyKey, status: 'succeeded', outcome: body.outcome };
  }
  if (body.status === 'failed') {
    if (
      Object.keys(body).some(
        (key) => key !== 'idempotencyKey' && key !== 'status' && key !== 'reason',
      )
    )
      return invalidRequest('', 'The command body contains unknown fields');
    const reason = body.reason;
    if (typeof reason !== 'string' || reason.trim() === '')
      return invalidRequest('reason', 'Must be a non-empty string');
    if (reason.length > 2_000) return invalidRequest('reason', 'Must be at most 2000 characters');
    return { idempotencyKey, status: 'failed', reason };
  }
  return invalidRequest('status', 'Must be either succeeded or failed');
}

function isHttpResponse(value: unknown): value is ApiHttpResponse {
  return typeof value === 'object' && value !== null && 'body' in value;
}
