import type { RunnerResponse } from '../contracts/index.js';
import type { ApiHttpResponse } from '../http-server.js';
import type { ApiApplications, ApiCommandRequest } from './applications.js';
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
  const request = commandRequest(body);
  if ('status' in request) return request;
  const work = await dispatchWorkCommand(applications, url.pathname, request);
  if (work !== undefined) return work;
  const control = await dispatchControlCommand(applications, url.pathname, request);
  if (control !== undefined) return control;
  const runner = await dispatchRunnerCommand(applications, url.pathname, request);
  return runner ?? problem(404, 'Not Found', `No command route for ${url.pathname}`);
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
  const operation = applications.controlPlane[name];
  return operation === undefined
    ? unavailable(name, (await applications.controlPlane.status()).data)
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
