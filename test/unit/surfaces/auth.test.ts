import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createPairingGrant,
  loadOrCreateCredentials,
  redeemPairingGrant,
  replaceAccessKey,
  verifyAccessKey,
  type CredentialMutationSerialiser,
} from '../../../src/surfaces/auth/credentials.js';

const serialiseCredentialMutation = (): CredentialMutationSerialiser => {
  let tail = Promise.resolve();
  return async (_lockPath, operation) => {
    const prior = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  };
};

describe('surface access credentials', () => {
  it('creates private credentials and rotates sessions when replacing the access key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-auth-'));
    const first = await loadOrCreateCredentials(root);
    const replacement = await replaceAccessKey(root, 'operator-key', serialiseCredentialMutation());

    expect(replacement.accessKey).toBe('operator-key');
    expect(replacement.sessionPassword).not.toBe(first.sessionPassword);
    expect(verifyAccessKey('operator-key', replacement.accessKey)).toBe(true);
    expect(verifyAccessKey('wrong', replacement.accessKey)).toBe(false);
    if (process.platform !== 'win32')
      expect((await stat(join(root, '.wake', 'auth', 'credentials.json'))).mode & 0o777).toBe(
        0o600,
      );
  });

  it('rejects an empty replacement access key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-auth-'));
    await expect(replaceAccessKey(root, '  ', serialiseCredentialMutation())).rejects.toThrow(
      'must not be empty',
    );
  });

  it('delegates mutations to the supplied credential serialiser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-auth-'));
    const lockPaths: string[] = [];

    await replaceAccessKey(root, 'operator-key', async (lockPath, operation) => {
      lockPaths.push(lockPath);
      return operation();
    });

    expect(lockPaths).toEqual([join(root, '.wake', 'locks', 'surface-credentials.lock')]);
  });

  it('stores only a hash for a single-use ten-minute pairing grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-auth-'));
    const grant = await createPairingGrant(
      root,
      new Date('2026-08-26T12:00:00.000Z'),
      serialiseCredentialMutation(),
    );
    const stored = await loadOrCreateCredentials(root);

    expect(grant.value).not.toContain(stored.accessKey);
    expect(JSON.stringify(stored)).not.toContain(grant.value);
    await expect(
      redeemPairingGrant(
        root,
        grant.value,
        new Date('2026-08-26T12:09:59.999Z'),
        serialiseCredentialMutation(),
      ),
    ).resolves.toBe(true);
    await expect(
      redeemPairingGrant(
        root,
        grant.value,
        new Date('2026-08-26T12:09:59.999Z'),
        serialiseCredentialMutation(),
      ),
    ).resolves.toBe(false);
  });

  it('redeems a pairing grant only once when requests arrive concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-auth-'));
    const serialise = serialiseCredentialMutation();
    const grant = await createPairingGrant(root, undefined, serialise);

    const results = await Promise.all([
      redeemPairingGrant(root, grant.value, undefined, serialise),
      redeemPairingGrant(root, grant.value, undefined, serialise),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
