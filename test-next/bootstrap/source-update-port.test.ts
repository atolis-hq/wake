import { describe, expect, it } from 'vitest';
import { createSourceUpdatePort } from '../../src-next/bootstrap/source-update-port.js';

describe('target source update port', () => {
  it('uses git status, checkout, and revision verification within the configured repository', async () => {
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
      { command: 'git', args: ['rev-parse', '--verify', 'HEAD'], cwd: '/source/wake' },
    ]);
  });

  it('discovers the latest version tag through the same repository-local process boundary', async () => {
    const calls: readonly string[][] = [];
    const port = createSourceUpdatePort({
      repoRoot: '/source/wake',
      execute: async (_command, args) => {
        (calls as string[][]).push([...args]);
        return 'v2.4.0\nv2.3.1\n';
      },
    });
    await expect(port.latestTag()).resolves.toBe('v2.4.0');
    expect(calls).toEqual([['tag', '--sort=-v:refname']]);
  });

  it('fails clearly when the repository has no version tag to apply', async () => {
    const port = createSourceUpdatePort({
      repoRoot: '/source/wake',
      execute: async () => '\n',
    });
    await expect(port.latestTag()).rejects.toThrow('No source version tag is available');
  });
});
