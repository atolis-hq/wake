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
} from '../../../src/surfaces/auth/credentials.js';

describe('surface access credentials', () => {
  it('creates private credentials and rotates sessions when replacing the access key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-auth-'));
    const first = await loadOrCreateCredentials(root);
    const replacement = await replaceAccessKey(root, 'operator-key');

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
    await expect(replaceAccessKey(root, '  ')).rejects.toThrow('must not be empty');
  });

  it('stores only a hash for a single-use ten-minute pairing grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-auth-'));
    const grant = await createPairingGrant(root, new Date('2026-08-26T12:00:00.000Z'));
    const stored = await loadOrCreateCredentials(root);

    expect(grant.value).not.toContain(stored.accessKey);
    expect(JSON.stringify(stored)).not.toContain(grant.value);
    await expect(
      redeemPairingGrant(root, grant.value, new Date('2026-08-26T12:09:59.999Z')),
    ).resolves.toBe(true);
    await expect(
      redeemPairingGrant(root, grant.value, new Date('2026-08-26T12:09:59.999Z')),
    ).resolves.toBe(false);
  });

  it('redeems a pairing grant only once when requests arrive concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-auth-'));
    const grant = await createPairingGrant(root);

    const results = await Promise.all([
      redeemPairingGrant(root, grant.value),
      redeemPairingGrant(root, grant.value),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
