import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadOrCreateCredentials,
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
});
