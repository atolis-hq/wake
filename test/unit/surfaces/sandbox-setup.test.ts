import { describe, expect, it, vi } from 'vitest';
import { runSandboxSetup } from '../../../src/surfaces/cli/commands/sandbox-setup.js';

describe('sandbox setup', () => {
  it('prepares persistent homes and configures GitHub CLI authentication when accepted', async () => {
    const runInteractive = vi.fn(async () => {});
    const prompt = vi.fn(async (message: string) => message.includes('GitHub'));
    const prepareCodexHome = vi.fn(async () => {});
    const ensureSshKey = vi.fn(async () => {});
    const configureGitIdentity = vi.fn(async () => {});

    await runSandboxSetup({
      prompt,
      runInteractive,
      prepareCodexHome,
      ensureSshKey,
      configureGitIdentity,
      log: vi.fn(),
    });

    expect(prepareCodexHome).toHaveBeenCalledOnce();
    expect(ensureSshKey).toHaveBeenCalledOnce();
    expect(runInteractive).toHaveBeenNthCalledWith(1, 'gh', ['auth', 'login']);
    expect(runInteractive).toHaveBeenNthCalledWith(2, 'gh', ['auth', 'setup-git']);
    expect(configureGitIdentity).toHaveBeenCalledOnce();
  });

  it('does not configure a git identity when GitHub auth is skipped', async () => {
    const configureGitIdentity = vi.fn(async () => {});

    await runSandboxSetup({
      prompt: vi.fn(async () => false),
      runInteractive: vi.fn(async () => {}),
      prepareCodexHome: vi.fn(async () => {}),
      ensureSshKey: vi.fn(async () => {}),
      configureGitIdentity,
      log: vi.fn(),
    });

    expect(configureGitIdentity).not.toHaveBeenCalled();
  });
});
