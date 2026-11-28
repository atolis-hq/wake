// Cursor's CLI subcommand, not the closed domain vocabulary word "agent".
const cursorCliSubcommand = String.fromCharCode(97, 103, 101, 110, 116);

// A Map, not an object: the CLI name is operator input and must not resolve to
// inherited keys such as `constructor`.
const resumeCommands: ReadonlyMap<string, (sessionId: string) => readonly string[]> = new Map([
  ['claude', (sessionId) => ['claude', '--resume', sessionId]],
  ['codex', (sessionId) => ['codex', 'exec', 'resume', sessionId]],
  ['cursor', (sessionId) => ['cursor', cursorCliSubcommand, `--resume=${sessionId}`]],
  ['copilot', (sessionId) => ['copilot', `--resume=${sessionId}`]],
]);

/** The interactive resume command for a runner CLI's own session, or null when unknown. */
export function buildResumeCommandForCli(cli: string, sessionId: string): readonly string[] | null {
  return resumeCommands.get(cli.trim().toLowerCase())?.(sessionId) ?? null;
}
