import { describe, expect, it, vi } from 'vitest';
import { runSandboxSetup } from '../../../src-next/surfaces/cli/commands/sandbox-setup.js';

describe('sandbox setup', () => {
  it('prepares persistent homes and configures GitHub CLI authentication when accepted', async () => {
    const runInteractive = vi.fn(async () => {});
    const prompt = vi.fn(async (message: string) => message.includes('GitHub'));
    const prepareCodexHome = vi.fn(async () => {});
    const ensureSshKey = vi.fn(async () => {});

    await runSandboxSetup({ prompt, runInteractive, prepareCodexHome, ensureSshKey, log: vi.fn() });

    expect(prepareCodexHome).toHaveBeenCalledOnce();
    expect(ensureSshKey).toHaveBeenCalledOnce();
    expect(runInteractive).toHaveBeenNthCalledWith(1, 'gh', ['auth', 'login']);
    expect(runInteractive).toHaveBeenNthCalledWith(2, 'gh', ['auth', 'setup-git']);
  });
});
