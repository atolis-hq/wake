import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSession,
  sessionCookieName,
  validSession,
} from '../../../src/surfaces/auth/session.js';
import {
  createHttpAuth,
  loadOrCreateCredentials,
  setAccessKey,
} from '../../../src/surfaces/index.js';

describe('surface auth', () => {
  it('creates private credentials and preserves the session secret when changing the access key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-auth-'));
    const first = await loadOrCreateCredentials(root);
    const second = await setAccessKey(root, 'memorable key');
    expect(second).toMatchObject({
      accessKey: 'memorable key',
      sessionSecret: first.sessionSecret,
    });
    if (process.platform !== 'win32')
      expect((await stat(join(root, '.wake/auth/credentials.json'))).mode & 0o777).toBe(0o600);
  });

  it('rejects anonymous API requests, then accepts a signed login session', () => {
    const credentials = {
      accessKey: 'key',
      sessionSecret: 'secret',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const auth = createHttpAuth(credentials);
    const request = (cookie?: string) =>
      ({ headers: cookie === undefined ? {} : { cookie } }) as never;
    expect(auth.authorize(request(), '/api/v1/system/health', 'GET', undefined)?.status).toBe(401);
    const login = auth.authorize(request(), '/api/v1/auth/login', 'POST', { accessKey: 'key' });
    expect(login?.status).toBe(200);
    expect(
      auth.authorize(
        request(login?.headers?.['set-cookie']),
        '/api/v1/system/health',
        'GET',
        undefined,
      ),
    ).toBeUndefined();
  });

  it('detects tampered and expired sessions', () => {
    const token = createSession('secret', 0);
    expect(validSession(token, 'secret', 1)).toBe(true);
    expect(validSession(`${token}x`, 'secret', 1)).toBe(false);
    expect(validSession(token, 'secret', 365 * 24 * 60 * 60 * 1000 + 1)).toBe(false);
    expect(sessionCookieName).toBe('wake_session');
  });
});
