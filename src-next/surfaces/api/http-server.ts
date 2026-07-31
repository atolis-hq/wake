import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AssetSource } from '../web-host/asset-source.js';
import { problemDetails } from './problem-details.js';
import { BrowserRouteOutcome, routeBrowserRequest } from './router.js';

export interface ApiHttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A transport-only dispatcher supplied by Bootstrap composition. */
export interface ApiDispatcher {
  dispatch(method: string, pathname: string, body: unknown): Promise<ApiHttpResponse | undefined>;
}

export function createApiHttpServer(dispatcher: ApiDispatcher, assets?: AssetSource) {
  return createServer((request, response) => {
    void handleRequest(dispatcher, assets, request, response);
  });
}

async function handleRequest(
  dispatcher: ApiDispatcher,
  assets: AssetSource | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    await dispatchRequest(dispatcher, assets, request, response);
  } catch (error) {
    sendJson(response, errorResult(error));
  }
}

async function dispatchRequest(
  dispatcher: ApiDispatcher,
  assets: AssetSource | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://wake.local');
  const method = request.method ?? 'GET';
  const head = method === 'HEAD';
  const result = await dispatcher.dispatch(
    method,
    `${url.pathname}${url.search}`,
    await jsonBody(request),
  );
  if (result !== undefined) return sendJson(response, result, head);
  await serveWebRequest(assets, method, url.pathname, response, head);
}

async function serveWebRequest(
  assets: AssetSource | undefined,
  method: string,
  pathname: string,
  response: ServerResponse,
  head: boolean,
): Promise<void> {
  const asset = method === 'GET' || head ? await assets?.get(pathname) : undefined;
  if (asset !== undefined) return send(response, { status: 200, ...asset, head });
  if (routeBrowserRequest(method, pathname) === BrowserRouteOutcome.Spa) {
    const index = await assets?.get('/index.html');
    if (index !== undefined)
      return send(response, {
        status: 200,
        ...index,
        contentType: 'text/html; charset=utf-8',
        head,
      });
  }
  if (pathname.startsWith('/api/'))
    return sendJson(
      response,
      {
        status: 404,
        body: problemDetails(404, 'Not Found', `No route for ${pathname}`),
        contentType: 'application/problem+json',
      },
      head,
    );
  return send(response, {
    status: 404,
    contentType: 'text/plain; charset=utf-8',
    body: Buffer.from('Not Found'),
    head,
  });
}

function errorResult(error: unknown): ApiHttpResponse {
  return error instanceof MalformedJsonError
    ? {
        status: 400,
        body: problemDetails(400, 'Bad Request', 'The request body is not valid JSON.', {
          code: 'malformed-json',
        }),
        contentType: 'application/problem+json',
      }
    : {
        status: 500,
        body: problemDetails(500, 'Internal Server Error', 'Wake could not complete the request.'),
        contentType: 'application/problem+json',
      };
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MalformedJsonError();
  }
}

class MalformedJsonError extends Error {}

function sendJson(response: ServerResponse, result: ApiHttpResponse, head = false): void {
  send(response, {
    status: result.status,
    contentType: result.contentType ?? 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify(result.body)),
    ...(result.headers === undefined ? {} : { headers: result.headers }),
    head,
  });
}

interface SendOptions {
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
  readonly head?: boolean;
}

function send(response: ServerResponse, options: SendOptions): void {
  response.writeHead(options.status, {
    'content-type': options.contentType,
    'content-length': options.body.byteLength,
    ...options.headers,
  });
  response.end(options.head ? undefined : options.body);
}
