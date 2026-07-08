import { createClaudeRunner } from '../claude/claude-runner.js';
import { createCodexRunner } from '../codex/codex-runner.js';
import type { AgentRunner } from '../../core/contracts.js';
import type { WakeConfig } from '../../domain/types.js';

export type SupportedRunnerMode = Exclude<WakeConfig['runner']['mode'], 'fake'>;

export interface RunnerCliAdapter {
  mode: SupportedRunnerMode;
  cliName: string;
  runner: AgentRunner;
  smoke(config: WakeConfig, args: string[]): Promise<unknown>;
  buildResumeCommand(input: { sessionId: string }): string[];
}

export function createRunnerCliAdapter(input: {
  mode: SupportedRunnerMode;
  config: WakeConfig;
  cwd: string;
}): RunnerCliAdapter {
  if (input.mode === 'claude') {
    const runner = createClaudeRunner({
      command: input.config.runner.claude.command,
      cwd: input.cwd,
    });

    return {
      mode: 'claude',
      cliName: 'Claude',
      runner,
      async smoke(config, args) {
        if (args.includes('--remote-control')) {
          const result = await runner.startRemoteControlSmoke(config);
          return {
            mode: 'remote-control',
            exitCode: result.exitCode,
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim(),
            command: result.command,
            args: result.args,
          };
        }

        const result = await runner.smoke(config);
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

  const runner = createCodexRunner({
    command: input.config.runner.codex.command,
    cwd: input.cwd,
  });

  return {
    mode: 'codex',
    cliName: 'Codex',
    runner,
    async smoke(config) {
      const result = await runner.smoke(config);
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
