import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface SurfaceCredentials {
  readonly accessKey: string;
  readonly sessionPassword: string;
  readonly createdAt: string;
}

export function credentialsPath(wakeRoot: string): string {
  return join(wakeRoot, '.wake', 'auth', 'credentials.json');
}

export async function loadOrCreateCredentials(wakeRoot: string): Promise<SurfaceCredentials> {
  const path = credentialsPath(wakeRoot);
  try {
    return decodeCredentials(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const credentials = createCredentials();
  await saveCredentials(path, credentials);
  return credentials;
}

export async function replaceAccessKey(
  wakeRoot: string,
  accessKey: string,
): Promise<SurfaceCredentials> {
  if (accessKey.trim() === '') throw new Error('UI access key must not be empty');
  const current = await loadOrCreateCredentials(wakeRoot);
  const replacement: SurfaceCredentials = {
    ...current,
    accessKey,
    sessionPassword: randomBytes(32).toString('base64url'),
  };
  await saveCredentials(credentialsPath(wakeRoot), replacement);
  return replacement;
}

export function verifyAccessKey(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function createCredentials(): SurfaceCredentials {
  return {
    accessKey: randomBytes(24).toString('base64url'),
    sessionPassword: randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
  };
}

async function saveCredentials(path: string, credentials: SurfaceCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(credentials), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

function decodeCredentials(value: unknown): SurfaceCredentials {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('accessKey' in value) ||
    !('sessionPassword' in value) ||
    !('createdAt' in value) ||
    typeof value.accessKey !== 'string' ||
    typeof value.sessionPassword !== 'string' ||
    typeof value.createdAt !== 'string' ||
    Buffer.from(value.sessionPassword, 'base64url').byteLength !== 32
  )
    throw new Error('Wake UI credentials are malformed');
  return {
    accessKey: value.accessKey,
    sessionPassword: value.sessionPassword,
    createdAt: value.createdAt,
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
