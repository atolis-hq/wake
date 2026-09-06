import { describe, expect, it } from 'vitest';
import { createNpmUpdatePort } from '../../../src/bootstrap/npm-update-port.js';

describe('npm update port', () => {
  it('resolves the configured dist-tag to an exact immutable version', async () => {
    const calls: string[][] = [];
    const port = createNpmUpdatePort({
      packageName: '@atolis-hq/wake',
      distTag: 'next',
      registry: 'https://registry.example.test',
      execute: async (_command, args) => {
        calls.push([...args]);
        return '["1.2.3"]';
      },
    });
    await expect(port.candidateTags()).resolves.toEqual(['1.2.3']);
    expect(calls).toEqual([
      [
        'view',
        '@atolis-hq/wake@next',
        'version',
        '--json',
        '--registry=https://registry.example.test',
      ],
    ]);
  });

  it('does not overwrite the coordinating CLI while preparing a package update', async () => {
    const port = createNpmUpdatePort({
      packageName: '@atolis-hq/wake',
      execute: async () => '"1.2.3"',
    });
    await expect(port.checkout('1.2.3')).resolves.toBeUndefined();
    await expect(port.healthy()).resolves.toBe(true);
  });

  it('rejects malformed registry metadata', async () => {
    const port = createNpmUpdatePort({
      packageName: '@atolis-hq/wake',
      execute: async () => '"latest"',
    });
    await expect(port.candidateTags()).rejects.toThrow('npm returned an invalid version');
  });
});
