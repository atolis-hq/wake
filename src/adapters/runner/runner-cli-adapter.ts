import { createClaudeRunner } from '../claude/claude-runner.js';
import { createCodexRunner } from '../codex/codex-runner.js';
import type { AgentRunner } from '../../core/contracts.js';
import type { RunnerEntry, RunnerKind } from '../../domain/types.js';

export type SupportedRunnerMode = Exclude<RunnerKind, 'fake'>;

type RealRunnerEntry = Exclude<RunnerEntry, { kind: 'fake' }>;

function withoutKind<T extends RealRunnerEntry>(entry: T): Omit<T, 'kind'> {
  const { kind: _kind, ...settings } = entry;
  return settings as Omit<T, 'kind'>;
}

export interface RunnerCliAdapter {
  mode: SupportedRunnerMode;
  cliName: string;
  runner: AgentRunner;
  smoke(args: string[]): Promise<unknown>;
  buildResumeCommand(input: { sessionId: string }): string[];
}

export function createRunnerCliAdapter(input: {
  entry: RealRunnerEntry;
  cwd: string;
}): RunnerCliAdapter {
  if (input.entry.kind === 'claude') {
    const settings = withoutKind(input.entry);
    const runner = createClaudeRunner({
      command: settings.command,
      cwd: input.cwd,
      settings,
    });

    return {
      mode: 'claude',
      cliName: 'Claude',
      runner,
      async smoke(args) {
        if (args.includes('--remote-control')) {
          const result = await runner.startRemoteControlSmoke();
          return {
            mode: 'remote-control',
            exitCode: result.exitCode,
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim(),
            command: result.command,
            args: result.args,
          };
        }

        const result = await runner.smoke();
        return {
          mode: 'print-json',
          exitCode: result.exitCode,
          text: result.text,
          sessionId: result.sessionId,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        };
      },
      buildResumeCommand({ sessionId }) {
        return ['claude', '--resume', sessionId];
      },
    };
  }

  const settings = withoutKind(input.entry);
  const runner = createCodexRunner({
    command: settings.command,
    cwd: input.cwd,
    settings,
  });

  return {
    mode: 'codex',
    cliName: 'Codex',
    runner,
    async smoke() {
      const result = await runner.smoke();
      return {
        mode: 'jsonl',
        exitCode: result.exitCode,
        text: result.text,
        sessionId: result.sessionId,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
    },
    buildResumeCommand({ sessionId }) {
      return ['codex', 'resume', sessionId];
    },
  };
}

export function buildResumeCommandForCli(input: {
  cli: string;
  sessionId: string;
}): string[] | null {
  const normalizedCli = input.cli.trim().toLowerCase();

  if (normalizedCli === 'codex') {
    return ['codex', 'resume', input.sessionId];
  }

  if (normalizedCli === 'claude') {
    return ['claude', '--resume', input.sessionId];
  }

  return null;
}
