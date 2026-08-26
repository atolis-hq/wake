import rateLimit from '@fastify/rate-limit';
import secureSession from '@fastify/secure-session';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifyAccessKey, type SurfaceCredentials } from '../auth/credentials.js';
import { SurfaceCookieSecurity, SurfaceSessionAttribute } from '../auth/vocabulary.js';
import type { AssetSource } from '../web-host/asset-source.js';
import { problemDetails } from './problem-details.js';
import { BrowserRouteOutcome, routeBrowserRequest } from './router.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    operator?: boolean;
  }
}

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

export interface SurfaceHttpServerOptions {
  readonly dispatcher: ApiDispatcher;
  readonly credentials: SurfaceCredentials;
  readonly assets?: AssetSource;
}

/**
 * The production HTTP surface. Public login routes are declared separately;
 * every operational API route is protected in its own Fastify scope before
 * Fastify parses the request body.
 */
export function createSurfaceHttpServer(options: SurfaceHttpServerOptions): FastifyInstance {
  const app = Fastify({ bodyLimit: 64 * 1024, trustProxy: true });
  app.register(rateLimit, { global: false });
  app.register(secureSession, {
    key: Buffer.from(options.credentials.sessionPassword, 'base64url'),
    cookieName: 'wake_session',
    expiry: 24 * 60 * 60,
    cookie: { httpOnly: true, sameSite: 'lax', secure: SurfaceCookieSecurity.Auto, path: '/' },
  });
  app.setErrorHandler((error, _request, reply) => {
    if (isFastifyBodyLimitError(error))
      return sendFastifyJson(
        reply,
        {
          status: 413,
          body: problemDetails(413, 'Payload Too Large', 'The request body is too large.', {
            code: 'payload-too-large',
          }),
          contentType: 'application/problem+json',
        },
        false,
      );
    if (error instanceof SyntaxError)
      return sendFastifyJson(reply, errorResult(new MalformedJsonError()), false);
    return sendFastifyJson(reply, errorResult(error), false);
  });

  app.get('/api/v1/auth/session', async (request, reply) => {
    if (request.session.get(SurfaceSessionAttribute.Operator) === true)
      return { authenticated: true };
    return reply.code(401).send({ status: 401, title: 'Unauthorized' });
  });
  app.post<{ Body: { accessKey?: unknown } }>(
    '/api/v1/auth/login',
    { bodyLimit: 1024, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const key = typeof request.body?.accessKey === 'string' ? request.body.accessKey : '';
      if (!verifyAccessKey(key, options.credentials.accessKey))
        return reply.code(401).send({ status: 401, title: 'Unauthorized' });
      request.session.set(SurfaceSessionAttribute.Operator, true);
      return { authenticated: true };
    },
  );

  app.register(
    (protectedApi, _pluginOptions, done) => {
      protectedApi.addHook('onRequest', async (request, reply) => {
        if (request.session.get(SurfaceSessionAttribute.Operator) !== true)
          return reply.code(401).send({ status: 401, title: 'Unauthorized' });
      });
      protectedApi.all('/*', async (request, reply) => {
        const result = await options.dispatcher.dispatch(
          request.method,
          request.raw.url ?? request.url,
          request.body,
        );
        if (result === undefined)
          return sendFastifyJson(
            reply,
            {
              status: 404,
              body: problemDetails(404, 'Not Found', `No route for ${request.url}`),
              contentType: 'application/problem+json',
            },
            request.method === 'HEAD',
          );
        return sendFastifyJson(reply, result, request.method === 'HEAD');
      });
      done();
    },
    { prefix: '/api/v1' },
  );

  app.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    handler: async (request, reply) => {
      const pathname = new URL(request.raw.url ?? request.url, 'http://wake.local').pathname;
      const head = request.method === 'HEAD';
      const asset = await options.assets?.get(pathname);
      if (asset !== undefined) return sendFastifyAsset(reply, asset, head);
      if (routeBrowserRequest(request.method, pathname) === BrowserRouteOutcome.Spa) {
        const index = await options.assets?.get('/index.html');
        if (index !== undefined)
          return sendFastifyAsset(
            reply,
            { ...index, contentType: 'text/html; charset=utf-8' },
            head,
          );
      }
      return reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send(head ? undefined : 'Not Found');
    },
  });
  return app;
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
  if (error instanceof MalformedJsonError)
    return {
      status: 400,
      body: problemDetails(400, 'Bad Request', 'The request body is not valid JSON.', {
        code: 'malformed-json',
      }),
      contentType: 'application/problem+json',
    };
  if (isUpstreamProviderError(error))
    return {
      status: 502,
      body: problemDetails(
        502,
        'Bad Gateway',
        'Wake could not complete the request because an external provider call failed (e.g. GitHub rate-limited or was unreachable). Retrying shortly usually resolves this.',
        { code: 'upstream-provider-error' },
      ),
      contentType: 'application/problem+json',
    };
  return {
    status: 500,
    body: problemDetails(500, 'Internal Server Error', 'Wake could not complete the request.'),
    contentType: 'application/problem+json',
  };
}

// Duck-types an octokit RequestError (or any similarly-shaped upstream HTTP
// client failure) by its `.status` field — the same detection already used
// for GitHub 404s in integrations/github/provider.ts's verifyArtifact. A
// synchronous command (like manual tick) that happens to run while an
// external provider is rate-limited or unreachable should surface as a
// distinguishable gateway failure, not an opaque "Internal Server Error"
// indistinguishable from an actual Wake bug.
function isUpstreamProviderError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    error.status >= 400
  );
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

function sendFastifyJson(reply: FastifyReply, result: ApiHttpResponse, head: boolean) {
  reply.code(result.status);
  reply.headers(result.headers ?? {});
  reply.type(result.contentType ?? 'application/json; charset=utf-8');
  return reply.send(head ? undefined : result.body);
}

function sendFastifyAsset(
  reply: FastifyReply,
  asset: {
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly headers: Readonly<Record<string, string>>;
  },
  head: boolean,
) {
  reply.code(200);
  reply.headers(asset.headers);
  reply.header('content-length', asset.body.byteLength);
  reply.type(asset.contentType);
  return reply.send(head ? undefined : asset.body);
}

function isFastifyBodyLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
  );
}
