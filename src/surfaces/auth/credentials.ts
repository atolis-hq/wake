import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface AuthCredentials {
  readonly accessKey: string;
  readonly sessionSecret: string;
  readonly createdAt: string;
}

export function credentialsPath(wakeRoot: string): string {
  return join(wakeRoot, '.wake', 'auth', 'credentials.json');
}

export async function loadOrCreateCredentials(wakeRoot: string): Promise<AuthCredentials> {
  const path = credentialsPath(wakeRoot);
  try {
    return decodeCredentials(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const credentials: AuthCredentials = {
    accessKey: randomBytes(24).toString('base64url'),
    sessionSecret: randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
  };
  await saveCredentials(wakeRoot, credentials);
  return credentials;
}

export async function setAccessKey(wakeRoot: string, accessKey: string): Promise<AuthCredentials> {
  if (accessKey.trim() === '') throw new Error('UI access key must not be empty');
  const current = await loadOrCreateCredentials(wakeRoot);
  const credentials = { ...current, accessKey };
  await saveCredentials(wakeRoot, credentials);
  return credentials;
}

async function saveCredentials(wakeRoot: string, credentials: AuthCredentials): Promise<void> {
  const path = credentialsPath(wakeRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(credentials), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

function decodeCredentials(value: unknown): AuthCredentials {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('accessKey' in value) ||
    !('sessionSecret' in value) ||
    !('createdAt' in value) ||
    typeof value.accessKey !== 'string' ||
    typeof value.sessionSecret !== 'string' ||
    typeof value.createdAt !== 'string'
  )
    throw new Error('Wake auth credentials are malformed');
  return value as AuthCredentials;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
