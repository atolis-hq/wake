import { createHmac, timingSafeEqual } from 'node:crypto';

const yearSeconds = 365 * 24 * 60 * 60;
export const sessionCookieName = 'wake_session';

export function createSession(secret: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ issuedAt: now, expiresAt: now + yearSeconds * 1000 }),
  ).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function validSession(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (token === undefined) return false;
  const [payload, signature, extra] = token.split('.');
  if (payload === undefined || signature === undefined || extra !== undefined) return false;
  const expected = sign(payload, secret);
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return false;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'expiresAt' in parsed &&
      typeof parsed.expiresAt === 'number' &&
      parsed.expiresAt > now
    );
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${sessionCookieName}=${token}; Max-Age=${yearSeconds}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function readCookie(header: string | undefined): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookieName}=`))
    ?.slice(sessionCookieName.length + 1);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}
