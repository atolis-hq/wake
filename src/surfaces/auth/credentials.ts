import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileLock } from '../../persistence/index.js';

export interface SurfaceCredentials {
  readonly accessKey: string;
  readonly sessionPassword: string;
  readonly createdAt: string;
  readonly pairingGrants?: readonly PairingGrantRecord[];
}

interface PairingGrantRecord {
  readonly hash: string;
  readonly expiresAt: string;
}

export interface SurfacePairingGrant {
  readonly value: string;
  readonly expiresAt: string;
}

const pairingGrantLifetimeMs = 10 * 60 * 1000;
const credentialLockName = 'surface-credentials.lock';

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
  const path = credentialsPath(wakeRoot);
  return mutateCredentials(path, async () => {
    const current = await loadOrCreateCredentials(wakeRoot);
    const replacement: SurfaceCredentials = {
      ...current,
      accessKey,
      sessionPassword: randomBytes(32).toString('base64url'),
    };
    await saveCredentials(path, replacement);
    return replacement;
  });
}

export async function createPairingGrant(
  wakeRoot: string,
  now = new Date(),
): Promise<SurfacePairingGrant> {
  const path = credentialsPath(wakeRoot);
  return mutateCredentials(path, async () => {
    const current = await loadOrCreateCredentials(wakeRoot);
    const value = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + pairingGrantLifetimeMs).toISOString();
    const active = (current.pairingGrants ?? [])
      .filter((grant) => grant.expiresAt > now.toISOString())
      .slice(-19);
    await saveCredentials(path, {
      ...current,
      pairingGrants: [...active, { hash: grantHash(value), expiresAt }],
    });
    return { value, expiresAt };
  });
}

export async function redeemPairingGrant(
  wakeRoot: string,
  value: string,
  now = new Date(),
): Promise<boolean> {
  const path = credentialsPath(wakeRoot);
  return mutateCredentials(path, async () => {
    const current = await loadOrCreateCredentials(wakeRoot);
    const nowIso = now.toISOString();
    const hash = grantHash(value);
    const grants = current.pairingGrants ?? [];
    const matching = grants.find((grant) => grant.hash === hash && grant.expiresAt > nowIso);
    const remaining = grants.filter((grant) => grant.expiresAt > nowIso && grant.hash !== hash);
    if (matching === undefined) {
      if (remaining.length !== grants.length)
        await saveCredentials(path, { ...current, pairingGrants: remaining });
      return false;
    }
    await saveCredentials(path, { ...current, pairingGrants: remaining });
    return true;
  });
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
    pairingGrants: [],
  };
}

async function saveCredentials(path: string, credentials: SurfaceCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(credentials), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

async function mutateCredentials<Result>(
  path: string,
  mutation: () => Promise<Result>,
): Promise<Result> {
  return withFileLock(credentialLockPath(path), mutation, {
    waitMs: 5_000,
    retryIntervalMs: 10,
  });
}

function credentialLockPath(credentials: string): string {
  return join(dirname(dirname(credentials)), 'locks', credentialLockName);
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
    pairingGrants:
      'pairingGrants' in value && Array.isArray(value.pairingGrants)
        ? value.pairingGrants.flatMap((grant) =>
            typeof grant === 'object' &&
            grant !== null &&
            'hash' in grant &&
            'expiresAt' in grant &&
            typeof grant.hash === 'string' &&
            typeof grant.expiresAt === 'string'
              ? [{ hash: grant.hash, expiresAt: grant.expiresAt }]
              : [],
          )
        : [],
  };
}

function grantHash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
