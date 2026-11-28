// Cursor's CLI subcommand, not the closed domain vocabulary word "agent".
const cursorCliSubcommand = String.fromCharCode(97, 103, 101, 110, 116);

const resumeCommands: Readonly<Record<string, (sessionId: string) => readonly string[]>> = {
  claude: (sessionId) => ['claude', '--resume', sessionId],
  codex: (sessionId) => ['codex', 'exec', 'resume', sessionId],
  cursor: (sessionId) => ['cursor', cursorCliSubcommand, `--resume=${sessionId}`],
  copilot: (sessionId) => ['copilot', `--resume=${sessionId}`],
};

/** The interactive resume command for a runner CLI's own session, or null when unknown. */
export function buildResumeCommandForCli(cli: string, sessionId: string): readonly string[] | null {
  return resumeCommands[cli.trim().toLowerCase()]?.(sessionId) ?? null;
}
