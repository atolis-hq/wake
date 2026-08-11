import { execFileSync } from 'node:child_process';

type RunCommand = (command: string, arguments_: readonly string[]) => string;

/** Resolves the credential held by the GitHub CLI inside the Wake sandbox. */
export function resolveGitHubCliToken(run: RunCommand = runGhAuthToken): string {
  try {
    const token = run('gh', ['auth', 'token']).trim();
    if (token.length > 0) return token;
  } catch {
    // The common cause is an unauthenticated or unavailable GitHub CLI.
  }
  throw new Error(
    'GitHub authentication is unavailable. Run `wake sandbox setup` and complete `gh auth login`.',
  );
}

function runGhAuthToken(command: string, arguments_: readonly string[]): string {
  return execFileSync(command, arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}
