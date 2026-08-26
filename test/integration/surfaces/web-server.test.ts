import { describe, expect, it } from 'vitest';
import {
  createSurfaceHttpServer,
  type ApiDispatcher,
} from '../../../src/surfaces/api/http-server.js';
import { routeBrowserRequest } from '../../../src/surfaces/api/router.js';
import { createApiDispatcher } from '../../../src/surfaces/api/routes/index.js';

describe('browser history routing', () => {
  it('falls back only for extensionless non-API GET requests', () => {
    expect(routeBrowserRequest('GET', '/work/work-demo')).toBe('spa');
    expect(routeBrowserRequest('GET', '/api/v1/nope')).toBe('not-found');
    expect(routeBrowserRequest('GET', '/assets/nope.js')).toBe('not-found');
  });

  it('serves a packaged shell for a clean route without masking unknown API or asset routes', async () => {
    const server = surfaceServer(createApiDispatcher(applications()), {
      get: async (path) =>
        path === '/index.html'
          ? {
              body: new TextEncoder().encode('<main>Wake</main>'),
              contentType: 'text/html',
              headers: { 'cache-control': 'no-cache' },
            }
          : undefined,
    });
    try {
      expect((await server.inject('/work/work-demo')).body).toContain('Wake');
      const apiMissing = await server.inject({
        method: 'GET',
        url: '/api/v1/nope',
        headers: { cookie: await login(server) },
      });
      const assetMissing = await server.inject('/assets/nope.js');
      expect(apiMissing.statusCode).toBe(404);
      expect(apiMissing.headers['content-type']).toContain('application/problem+json');
      expect(assetMissing.statusCode).toBe(404);
      expect(assetMissing.headers['content-type']).not.toContain('application/problem+json');
    } finally {
      await server.close();
    }
  });
});

describe('HTTP Surface hardening', () => {
  it('allows operational API access only when auth is explicitly disabled', async () => {
    const server = createSurfaceHttpServer({
      dispatcher: createApiDispatcher(applications()),
      credentials: {
        accessKey: 'operator-key',
        sessionPassword: Buffer.alloc(32, 4).toString('base64url'),
        createdAt: '2026-08-26T00:00:00.000Z',
      },
      auth: { disabled: true, redeemGrant: async () => false },
    });
    try {
      const response = await server.inject('/api/v1/control-plane/status');
      expect(response.statusCode).toBe(200);
      expect((await server.inject('/api/v1/auth/session')).json()).toEqual({ authenticated: true });
    } finally {
      await server.close();
    }
  });

  it('requires a configured auth boundary for every operational API route', async () => {
    const server = surfaceServer(createApiDispatcher(applications()));
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/control-plane/commands/tick',
        payload: 'x'.repeat(1024 * 1024),
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('creates a secure login session that grants the protected API scope', async () => {
    const server = surfaceServer(createApiDispatcher(applications()));
    try {
      const rejected = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { accessKey: 'incorrect' },
      });
      expect(rejected.statusCode).toBe(401);

      const login = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { accessKey: 'operator-key' },
      });
      expect(login.statusCode).toBe(200);
      const setCookie = login.headers['set-cookie'];
      if (typeof setCookie !== 'string') throw new Error('Expected login session cookie');
      const cookie = setCookie.split(';', 1)[0]!;
      expect(cookie).toContain('wake_session=');

      const session = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        headers: { cookie },
      });
      expect(session.json()).toEqual({ authenticated: true });

      const operational = await server.inject({
        method: 'GET',
        url: '/api/v1/control-plane/status',
        headers: { cookie },
      });
      expect(operational.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('does not expose an unexpected application error message', async () => {
    const server = surfaceServer({
      dispatch: async () => {
        throw new Error('C:\\private\\wake-root\\secret');
      },
    });
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/system/health',
        headers: { cookie: await login(server) },
      });
      const body = response.body;
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(body).not.toContain('private');
      expect(body).not.toContain('secret');
    } finally {
      await server.close();
    }
  });

  it('maps an upstream provider failure (e.g. a GitHub rate-limit error) to a 502, not a 500', async () => {
    const server = surfaceServer({
      dispatch: async () => {
        throw Object.assign(new Error('API rate limit exceeded for user ID 300234579'), {
          status: 403,
        });
      },
    });
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/system/health',
        headers: { cookie: await login(server) },
      });
      expect(response.statusCode).toBe(502);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ status: 502, code: 'upstream-provider-error' });
    } finally {
      await server.close();
    }
  });

  it('maps malformed JSON to an exact RFC9457 400 response', async () => {
    const server = surfaceServer(createApiDispatcher(applications()));
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/control-plane/commands/tick',
        headers: { 'content-type': 'application/json', cookie: await login(server) },
        payload: '{not-json',
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ status: 400, code: 'malformed-json' });
    } finally {
      await server.close();
    }
  });

  it('supports HEAD without sending a representation body', async () => {
    const server = surfaceServer(createApiDispatcher(applications()));
    try {
      const response = await server.inject({
        method: 'HEAD',
        url: '/api/v1/control-plane/status',
        headers: { cookie: await login(server) },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('');
    } finally {
      await server.close();
    }
  });

  it('does not serve static assets for mutation methods', async () => {
    const server = surfaceServer(createApiDispatcher(applications()), {
      get: async (path) =>
        path === '/assets/app-a1b2.js'
          ? { body: new Uint8Array([1]), contentType: 'text/javascript', headers: {} }
          : undefined,
    });
    try {
      const response = await server.inject({ method: 'POST', url: '/assets/app-a1b2.js' });
      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});

function surfaceServer(
  dispatcher: ApiDispatcher,
  assets?: Parameters<typeof createSurfaceHttpServer>[0]['assets'],
) {
  return createSurfaceHttpServer({
    dispatcher,
    credentials: {
      accessKey: 'operator-key',
      sessionPassword: Buffer.alloc(32, 1).toString('base64url'),
      createdAt: '2026-08-26T00:00:00.000Z',
    },
    ...(assets === undefined ? {} : { assets }),
  });
}

async function login(server: ReturnType<typeof createSurfaceHttpServer>): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { accessKey: 'operator-key' },
  });
  const setCookie = response.headers['set-cookie'];
  if (typeof setCookie !== 'string') throw new Error('Expected login session cookie');
  return setCookie.split(';', 1)[0]!;
}

function applications() {
  const meta = { asOf: '2026-07-31T10:00:00.000Z' };
  const page = { items: [], total: 0, meta };
  return {
    now: () => '2026-07-31T10:00:00.000Z',
    controlPlane: {
      status: async () => ({
        data: { paused: false, updatedAt: '2026-07-31T10:00:00.000Z' },
        meta,
      }),
    },
    work: { list: async () => page, detail: async () => undefined },
    resources: { list: async () => page },
    orchestration: { list: async () => page },
    execution: { list: async () => page },
    events: { list: async () => page },
    observability: {
      metrics: async () => ({
        data: {
          collectedAt: '2026-07-31T10:00:00.000Z',
          window: { days: 7, from: '2026-07-25', to: '2026-07-31' },
          values: {},
        },
        meta,
      }),
    },
    system: {
      health: async () => ({
        data: {
          status: 'ok' as const,
          version: '0.1.0-test',
          checkedAt: '2026-07-31T10:00:00.000Z',
        },
        meta,
      }),
      configuration: async () => ({ data: { configuration: {} }, meta }),
      commands: async () => ({ data: { adapters: [] }, meta }),
    },
  };
}
