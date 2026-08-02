export interface SandboxSetupDependencies {
  readonly prompt: (message: string) => Promise<boolean>;
  readonly runInteractive: (command: string, arguments_: readonly string[]) => Promise<void>;
  readonly ensureSshKey: () => Promise<void>;
  readonly prepareCodexHome: () => Promise<void>;
  readonly log: (message: string) => void;
}

/** Configures the sandbox-owned credentials and git identity interactively. */
export async function runSandboxSetup(deps: SandboxSetupDependencies): Promise<void> {
  deps.log('Wake sandbox setup starting.');
  await deps.prepareCodexHome();
  await deps.ensureSshKey();

  if (await deps.prompt('Configure GitHub auth? [y/N]')) {
    deps.log(
      'Use a dedicated GitHub identity with only the repository access Wake needs when possible.',
    );
    await deps.runInteractive('gh', ['auth', 'login']);
    await deps.runInteractive('gh', ['auth', 'setup-git']);
  } else {
    deps.log('Skipping GitHub auth setup.');
  }

  if (await deps.prompt('Configure Claude auth? [y/N]'))
    await deps.runInteractive('claude', ['auth', 'login', '--claudeai']);
  else deps.log('Skipping Claude auth setup.');

  if (await deps.prompt('Configure Codex auth? [y/N]'))
    await deps.runInteractive('codex', ['login', '--device-auth']);
  else deps.log('Skipping Codex auth setup.');

  if (await deps.prompt('Configure Cursor auth? [y/N]'))
    await deps.runInteractive('agent', ['login']);
  else deps.log('Skipping Cursor auth setup.');
}
