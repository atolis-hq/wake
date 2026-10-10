import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactPath, FileArtifactStore } from '../../../src/artifacts/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('FileArtifactStore', () => {
  it('stores opaque revision bytes beneath their work item', async () => {
    const root = await directory();
    const store = new FileArtifactStore(root);

    const stored = await store.write({
      workItemId: 'work-01j00000000000000000000000',
      revisionId: 'revision-01j00000000000000000000000',
      path: artifactPath('spec/plan.md'),
      bytes: new TextEncoder().encode('hello'),
    });

    expect(stored).toMatchObject({
      location: expect.stringContaining('work-01j00000000000000000000000/'),
      byteLength: 5,
      digest: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(new TextDecoder().decode(await store.read(stored.location))).toBe('hello');
  });

  it('keeps concurrent writes to the same revision immutable and internally consistent', async () => {
    const store = new FileArtifactStore(await directory());
    const writes = ['first', 'second'].map((content) => ({
      workItemId: 'work-concurrent',
      revisionId: 'revision-same',
      path: artifactPath('spec.md'),
      bytes: new TextEncoder().encode(content),
    }));
    const results = await Promise.all(writes.map((input) => store.write(input)));
    for (const [index, stored] of results.entries()) {
      expect(new Uint8Array(await store.read(stored.location))).toEqual(writes[index]!.bytes);
    }
    expect(results[0]!.location).not.toEqual(results[1]!.location);
  });

  it('rejects paths that can escape an owner namespace', () => {
    expect(() => artifactPath('../spec.md')).toThrow('normalized relative path');
    expect(() => artifactPath('/spec.md')).toThrow('normalized relative path');
    expect(() => artifactPath('spec\\plan.md')).toThrow('normalized relative path');
  });
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wake-artifacts-'));
  directories.push(path);
  return path;
}
