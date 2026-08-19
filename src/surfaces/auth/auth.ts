import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ApiHttpResponse } from '../contracts/http.js';
import type { AuthCredentials } from './credentials.js';
import { createSession, readCookie, sessionCookie, validSession } from './session.js';

export interface HttpAuth {
  authorize(
    request: IncomingMessage,
    pathname: string,
    method: string,
    body: unknown,
  ): ApiHttpResponse | undefined;
}

export function createHttpAuth(credentials: AuthCredentials, now = () => Date.now()): HttpAuth {
  let failures = 0;
  let lastFailure = 0;
  let lockedUntil = 0;

  function recordFailure(): void {
    if (now() - lastFailure > 15 * 60 * 1000) failures = 0;
    failures += 1;
    lastFailure = now();
    if (failures >= 5) lockedUntil = now() + 60 * 1000;
  }

  function handleLogin(request: IncomingMessage, body: unknown): ApiHttpResponse {
    if (now() < lockedUntil) return unauthorized();
    const key =
      typeof body === 'object' &&
      body !== null &&
      'accessKey' in body &&
      typeof body.accessKey === 'string'
        ? body.accessKey
        : '';
    if (!sameKey(key, credentials.accessKey)) {
      recordFailure();
      return unauthorized();
    }
    failures = 0;
    return {
      status: 200,
      body: { authenticated: true },
      headers: {
        'set-cookie': sessionCookie(
          createSession(credentials.sessionSecret, now()),
          request.headers['x-forwarded-proto'] === 'https',
        ),
      },
    };
  }

  return {
    authorize(request, pathname, method, body) {
      const authenticated = validSession(
        readCookie(request.headers.cookie),
        credentials.sessionSecret,
        now(),
      );
      if (pathname === '/api/v1/auth/session' && method === 'GET')
        return authenticated ? { status: 200, body: { authenticated: true } } : unauthorized();
      if (pathname === '/api/v1/auth/login' && method === 'POST') return handleLogin(request, body);
      if (pathname.startsWith('/api/') && !authenticated) return unauthorized();
      return undefined;
    },
  };
}

function sameKey(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function unauthorized(): ApiHttpResponse {
  return { status: 401, body: { status: 401, title: 'Unauthorized' } };
}
