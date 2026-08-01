import { describe, expect, it } from 'vitest';
import { runSandbox } from '../../src-next/surfaces/cli/commands/sandbox.js';

describe('sandbox', () => {
  it('forwards an explicit subcommand only through the Docker port', async () => {
    const calls: string[] = [];
    await runSandbox(['up'], {
      build: async () => calls.push('build'),
      up: async () => calls.push('up'),
      down: async () => calls.push('down'),
    });
    expect(calls).toEqual(['up']);
  });

  it('rejects unknown commands before invoking Docker', async () => {
    await expect(
      runSandbox(['destroy'], { build: async () => {}, up: async () => {}, down: async () => {} }),
    ).rejects.toThrow('Unknown sandbox command');
  });
});
