import { createClaudeRunner } from '../claude/claude-runner.js';
import { createCodexRunner } from '../codex/codex-runner.js';
import { createCursorRunner } from '../cursor/cursor-runner.js';
import type { AgentRunner } from '../../core/contracts.js';
import { runnerAbsoluteTimeoutMs } from '../../domain/runner-routing.js';
import type { RunnerEntry, RunnerKind, WakeConfig } from '../../domain/types.js';

export type SupportedRunnerMode = Exclude<RunnerKind, 'fake'>;

type RealRunnerEntry = Exclude<RunnerEntry, { kind: 'fake' }>;

function withoutKind<T extends RealRunnerEntry>(entry: T): Omit<T, 'kind'> {
  const { kind: _kind, ...settings } = entry;
  return settings as Omit<T, 'kind'>;
}

function resolvedRunnerSettings<T extends RealRunnerEntry>(input: {
  name: string;
  entry: T;
  config: WakeConfig;
}): Omit<T, 'kind'> & { timeoutMs: number; gracefulCancellationTimeoutMs: number } {
  return {
    ...withoutKind(input.entry),
    timeoutMs: runnerAbsoluteTimeoutMs(input.config, input.name),
    gracefulCancellationTimeoutMs: input.config.runs.gracefulCancellationTimeoutMs,
  };
}

export interface RunnerCliAdapter {
  mode: SupportedRunnerMode;
  cliName: string;
  runner: AgentRunner;
  smoke(args: string[]): Promise<unknown>;
  buildResumeCommand(input: { sessionId: string }): string[];
}

export function createRunnerCliAdapter(input: {
  name: string;
  entry: RealRunnerEntry;
  config: WakeConfig;
  cwd: string;
}): RunnerCliAdapter {
  if (input.entry.kind === 'claude') {
    const settings = resolvedRunnerSettings({
      name: input.name,
      entry: input.entry,
      config: input.config,
    });
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

  if (input.entry.kind === 'cursor') {
    const settings = resolvedRunnerSettings({
      name: input.name,
      entry: input.entry,
      config: input.config,
    });
    const runner = createCursorRunner({
      command: settings.command,
      cwd: input.cwd,
      settings,
    });

    return {
      mode: 'cursor',
      cliName: 'Cursor',
      runner,
      async smoke() {
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
        return ['cursor', 'agent', `--resume=${sessionId}`];
      },
    };
  }

  const settings = resolvedRunnerSettings({
    name: input.name,
    entry: input.entry,
    config: input.config,
  });
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
      return ['codex', 'exec', 'resume', sessionId];
    },
  };
}

export function buildResumeCommandForCli(input: {
  cli: string;
  sessionId: string;
}): string[] | null {
  const normalizedCli = input.cli.trim().toLowerCase();

  if (normalizedCli === 'codex') {
    return ['codex', 'exec', 'resume', input.sessionId];
  }

  if (normalizedCli === 'claude') {
    return ['claude', '--resume', input.sessionId];
  }

  if (normalizedCli === 'cursor') {
    return ['cursor', 'agent', `--resume=${input.sessionId}`];
  }

  return null;
}
