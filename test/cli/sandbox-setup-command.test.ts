import { describe, expect, it, vi } from 'vitest';
import { runSandboxSetupCommand } from '../../src/cli/sandbox-setup-command.js';

describe('runSandboxSetupCommand', () => {
  it('prepares the codex home and ssh key unconditionally, then prompts for each CLI auth', async () => {
    const log = vi.fn();
    const runInteractive = vi.fn(async () => {});
    const prompt = vi.fn(async (message: string) => message.includes('GitHub'));
    const ensureSshKey = vi.fn(async () => {});
    const prepareCodexHome = vi.fn(async () => {});

    await runSandboxSetupCommand({ prompt, runInteractive, ensureSshKey, prepareCodexHome, log });

    expect(prepareCodexHome).toHaveBeenCalledOnce();
    expect(ensureSshKey).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledTimes(4); // GitHub, Claude, Codex, Cursor
    expect(runInteractive).toHaveBeenCalledWith('gh', ['auth', 'login']);
    expect(runInteractive).toHaveBeenCalledWith('gh', ['auth', 'setup-git']);
    expect(runInteractive).not.toHaveBeenCalledWith('claude', expect.anything());
  });

  it('skips a CLI auth step entirely when its prompt is declined', async () => {
    const runInteractive = vi.fn(async () => {});
    const prompt = vi.fn(async () => false);

    await runSandboxSetupCommand({
      prompt,
      runInteractive,
      ensureSshKey: vi.fn(async () => {}),
      prepareCodexHome: vi.fn(async () => {}),
      log: vi.fn(),
    });

    expect(runInteractive).not.toHaveBeenCalled();
  });
});
