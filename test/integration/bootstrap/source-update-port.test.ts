import { describe, expect, it } from 'vitest';
import { createSourceUpdatePort } from '../../../src/bootstrap/source-update-port.js';

describe('target source update port', () => {
  it('uses git status, checkout, and build verification within the configured repository', async () => {
    const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
    const port = createSourceUpdatePort({
      repoRoot: '/source/wake',
      execute: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return args[0] === 'status' ? '' : 'ok';
      },
    });
    await expect(port.isClean()).resolves.toBe(true);
    await port.checkout('v2');
    await expect(port.healthy()).resolves.toBe(true);
    expect(calls).toEqual([
      { command: 'git', args: ['status', '--porcelain'], cwd: '/source/wake' },
      { command: 'git', args: ['checkout', 'v2'], cwd: '/source/wake' },
      { command: 'npm', args: ['exec', 'tsc', '--'], cwd: '/source/wake' },
    ]);
  });

  it('fetches remote release tags before discovering the latest version tag', async () => {
    const calls: readonly string[][] = [];
    const port = createSourceUpdatePort({
      repoRoot: '/source/wake',
      execute: async (_command, args) => {
        (calls as string[][]).push([...args]);
        return 'v2.4.0\nv2.3.1\n';
      },
    });
    await expect(port.latestTag()).resolves.toBe('v2.4.0');
    expect(calls).toEqual([
      ['fetch', '--tags'],
      ['tag', '--list', 'v*', '--sort=-v:refname'],
    ]);
  });

  it('fails clearly when the repository has no version tag to apply', async () => {
    const port = createSourceUpdatePort({
      repoRoot: '/source/wake',
      execute: async () => '\n',
    });
    await expect(port.latestTag()).rejects.toThrow('No source version tag is available');
  });

  it('fetches and lists only release candidates in version-sorted order (newest first)', async () => {
    const calls: string[][] = [];
    const port = createSourceUpdatePort({
      repoRoot: '/source/wake',
      execute: async (_command, args) => {
        calls.push([...args]);
        return 'v2.4.0\nv2.3.1\nv1.0.0\n';
      },
    });
    await expect(port.candidateTags()).resolves.toEqual(['v2.4.0', 'v2.3.1', 'v1.0.0']);
    expect(calls).toEqual([
      ['fetch', '--tags'],
      ['tag', '--list', 'v*', '--sort=-v:refname'],
    ]);
  });

  it('filters empty lines when listing candidate tags', async () => {
    const port = createSourceUpdatePort({
      repoRoot: '/source/wake',
      execute: async () => 'v2.4.0\n\nv2.3.1\n',
    });
    await expect(port.candidateTags()).resolves.toEqual(['v2.4.0', 'v2.3.1']);
  });

  it('verifies health by attempting to build the checked-out code', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const port = createSourceUpdatePort({
      repoRoot: '/source/wake',
      execute: async (command, args) => {
        calls.push({ command, args });
        return 'success';
      },
    });
    await expect(port.healthy()).resolves.toBe(true);
    expect(calls).toContainEqual({ command: 'npm', args: ['exec', 'tsc', '--'] });
  });

  it('reports unhealthy when the build fails', async () => {
    const port = createSourceUpdatePort({
      repoRoot: '/source/wake',
      execute: async (command, args) => {
        if (command === 'npm' && args[0] === 'exec' && args[1] === 'tsc') {
          throw new Error('TypeScript compilation failed');
        }
        return 'ok';
      },
    });
    await expect(port.healthy()).resolves.toBe(false);
  });
});
