export async function runSandboxSetupCommand(deps: {
  prompt: (message: string) => Promise<boolean>;
  runInteractive: (command: string, args: string[]) => Promise<void>;
  ensureSshKey: () => Promise<void>;
  prepareCodexHome: () => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  deps.log('Wake sandbox setup starting.');

  await deps.prepareCodexHome();
  await deps.ensureSshKey();

  if (await deps.prompt('Configure GitHub auth? [y/N]')) {
    deps.log(
      'Optional best practice: sign in with a dedicated GitHub identity for Wake-managed agent work, rather than your main personal account. Make sure it has only the repository access Wake needs.',
    );
    await deps.runInteractive('gh', ['auth', 'login']);
    await deps.runInteractive('gh', ['auth', 'setup-git']);
  } else {
    deps.log('Skipping GitHub auth setup.');
  }

  if (await deps.prompt('Configure Claude auth? [y/N]')) {
    await deps.runInteractive('claude', ['auth', 'login', '--claudeai']);
  } else {
    deps.log('Skipping Claude auth setup.');
  }

  if (await deps.prompt('Configure Codex auth? [y/N]')) {
    await deps.runInteractive('codex', ['login']);
  } else {
    deps.log('Skipping Codex auth setup.');
  }

  if (await deps.prompt('Configure Cursor auth? [y/N]')) {
    await deps.runInteractive('agent', ['login']);
  } else {
    deps.log('Skipping Cursor auth setup.');
  }
}
