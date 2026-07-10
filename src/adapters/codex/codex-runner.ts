/**
 * Codex runner notes and known parity gaps vs Claude:
 *
 * - Codex supports real non-interactive runs, resume, approval policy, sandbox
 *   mode, cwd selection, and JSONL event output, so Wake maps those directly.
 * - Codex does NOT expose a Claude-equivalent `--max-turns` cap for `exec`, so
 *   Wake cannot enforce `maxTurns` at the CLI boundary for this runner today.
 * - Codex does NOT expose a Claude-equivalent local-tool allowlist such as
 *   `--allowedTools`. Wake still renders the same stage prompt restrictions, but
 *   refine-stage tool limits are prompt-guided plus sandbox-limited, not
 *   CLI-enforced at per-tool granularity.
 * - Codex remote-control is app-driven rather than CLI-driven, so there is no
 *   honest equivalent to Claude's `smoke --remote-control` path here.
 * - Codex `exec` does not expose Claude-style session naming flags, so Wake
 *   cannot stamp per-run human-readable session names into the CLI invocation.
 *
 * Keep this comment aligned with docs/runner-comparison.md when the adapter or
 * public CLI surface changes.
 */
import type { AgentRunResult, AgentRunTokenUsage } from '../../core/contracts.js';
import type {
  AgentAction,
  EventEnvelope,
  IssueStateRecord,
  RunnerEntry,
  WakeConfig,
} from '../../domain/types.js';

type CodexRunnerSettings = Omit<Extract<RunnerEntry, { kind: 'codex' }>, 'kind'>;
import { buildStagePrompt } from '../runner/stage-prompt.js';
import { runAgentCliCommand } from '../runner/cli-command.js';

const CODEX_CLI_NAME = 'Codex';

export function buildCodexExecArgs(input: {
  model: string;
  prompt: string;
  harnessPrompt?: string;
  cwd: string;
  sandboxMode: 'workspace-write' | 'danger-full-access';
  reasoningEffort?: string;
}): string[] {
  const prompt =
    input.harnessPrompt === undefined
      ? input.prompt
      : `${input.harnessPrompt}\n\n${input.prompt}`;

  return [
    '--ask-for-approval',
    'never',
    ...(input.reasoningEffort === undefined
      ? []
      : ['-c', `model_reasoning_effort="${input.reasoningEffort}"`]),
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    input.sandboxMode,
    '--cd',
    input.cwd,
    '--model',
    input.model,
    prompt,
  ];
}

export function buildCodexResumeArgs(input: {
  sessionId: string;
}): string[] {
  return ['resume', input.sessionId];
}

function compactLogValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function formatCodexRunLogLine(input: {
  phase: 'start' | 'success' | 'failure';
  runId: string;
  action: AgentAction;
  issueNumber: number;
  repo: string;
  recentEventIds: string[];
  model?: string;
  workspacePath?: string;
  sessionId?: string;
  exitCode?: number;
}): string {
  const parts = [
    '[codex-run]',
    `phase=${input.phase}`,
    `runId=${input.runId}`,
    `cli=Codex`,
    ...(input.model === undefined ? [] : [`model=${input.model}`]),
    `repo=${input.repo}`,
    `issueNumber=${input.issueNumber}`,
    `action=${input.action}`,
    `recentEventIds=${
      input.recentEventIds.length > 0 ? input.recentEventIds.join(',') : '(none)'
    }`,
    ...(input.workspacePath === undefined
      ? []
      : [`workspacePath=${compactLogValue(input.workspacePath)}`]),
    ...(input.sessionId === undefined ? [] : [`sessionId=${input.sessionId}`]),
    ...(input.exitCode === undefined ? [] : [`exitCode=${input.exitCode}`]),
  ];

  return parts.join(' ');
}

export function extractCodexExecResult(stdout: string): {
  result: string;
  sessionId?: string;
  tokenUsage?: AgentRunTokenUsage;
} {
  let result: string | undefined;
  let sessionId: string | undefined;
  let tokenUsage: AgentRunTokenUsage | undefined;

  for (const line of stdout.split(/\r?\n/).filter((entry) => entry.trim().length > 0)) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id;
      continue;
    }

    if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        result = item.text;
      }
      continue;
    }

    if (event.type === 'turn.completed') {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage !== undefined) {
        tokenUsage = {
          inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
          outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
        };
      }
    }
  }

  if (result === undefined) {
    throw new Error('Codex exec JSONL stream did not include a final agent message.');
  }

  return {
    result,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  };
}

function resolveModel(input: {
  action: AgentAction;
  settings: CodexRunnerSettings;
}): string {
  const { models, model } = input.settings;

  const actionSpecificModel = models[input.action];
  if (actionSpecificModel !== undefined) {
    return actionSpecificModel;
  }

  if (models.default !== undefined) {
    return models.default;
  }

  return model;
}

function readSandboxLogBreadcrumb(): { text: string; metadata: { sandboxContainerName: string } } | null {
  const containerName = process.env.WAKE_SANDBOX_CONTAINER_NAME;
  if (containerName === undefined || containerName.length === 0) {
    return null;
  }

  return {
    text: `Sandbox logs: docker logs --tail 200 ${containerName}`,
    metadata: {
      sandboxContainerName: containerName,
    },
  };
}

function resolveSandboxMode(input: {
  action: AgentAction;
}): 'workspace-write' | 'danger-full-access' {
  return input.action === 'implement' ? 'danger-full-access' : 'workspace-write';
}

// Codex uses shell execution rather than Claude Code's named tools (Read/Glob/Grep).
// For read-only stages, override the tool capability note so the agent is told what it
// can actually use instead of Claude-specific tool names it does not have.
export function buildCodexToolCapabilityNote(input: {
  action: AgentAction;
  mode: 'start' | 'resume';
}): string | undefined {
  if (input.action !== 'refine') {
    return undefined;
  }
  const note =
    'You may read the repository using standard shell commands (cat, ls, find, grep, head, tail) and git status. ' +
    'The workspace-write sandbox prevents write and edit operations — do not attempt to modify files.';
  return input.mode === 'resume' ? `Reminder: this is still a planning-only stage. ${note}` : note;
}

export function createCodexRunner(options: {
  command: string;
  cwd: string;
  settings: CodexRunnerSettings;
}) {
  return {
    async run(input: {
      action: AgentAction;
      projection: IssueStateRecord;
      recentEvents: EventEnvelope[];
      config: WakeConfig;
      runId: string;
      workspacePath?: string;
    }): Promise<AgentRunResult> {
      const runMode = 'start';
      const toolCapabilityNote = buildCodexToolCapabilityNote({ action: input.action, mode: runMode });
      const stagePrompt = await buildStagePrompt({
        action: input.action,
        projection: input.projection,
        mode: runMode,
        config: input.config,
        ...(toolCapabilityNote !== undefined ? { contextOverrides: { toolCapabilityNote } } : {}),
      });

      const model = resolveModel({
        action: input.action,
        settings: options.settings,
      });

      const cwd = input.workspacePath ?? options.cwd;
      const sandboxMode = resolveSandboxMode({
        action: input.action,
      });
      console.log(
        formatCodexRunLogLine({
          phase: 'start',
          runId: input.runId,
          action: input.action,
          issueNumber: input.projection.issue.number,
          repo: input.projection.issue.repo,
          recentEventIds: input.recentEvents.map((event) => event.eventId),
          model,
          ...(input.workspacePath === undefined
            ? {}
            : { workspacePath: input.workspacePath }),
        }),
      );
      const result = await runAgentCliCommand({
        command: options.command,
        args: buildCodexExecArgs({
          model,
          prompt: stagePrompt.prompt,
          harnessPrompt: stagePrompt.harnessPrompt,
          cwd,
          sandboxMode,
          ...(options.settings.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: options.settings.reasoningEffort }),
        }),
        cwd,
        timeoutMs: options.settings.timeoutMs,
      });

      if (result.exitCode !== 0 || result.timedOut || result.stdout.trim().length === 0) {
        const sandboxLog = readSandboxLogBreadcrumb();
        console.error(
          formatCodexRunLogLine({
            phase: 'failure',
            runId: input.runId,
            action: input.action,
            issueNumber: input.projection.issue.number,
            repo: input.projection.issue.repo,
            recentEventIds: input.recentEvents.map((event) => event.eventId),
            model,
            ...(input.workspacePath === undefined
              ? {}
              : { workspacePath: input.workspacePath }),
            exitCode: result.exitCode,
          }),
        );
        return {
          result: [
            result.timedOut
              ? `Codex runner timed out after ${options.settings.timeoutMs}ms and was killed`
              : result.stdout.trim().length === 0 ? 'Codex runner produced no output'
              : 'Codex runner failed',
            result.stderr,
            sandboxLog?.text,
            'FAILED',
          ]
            .filter((part) => part !== undefined && part.length > 0)
            .join('\n'),
          model,
          cli: CODEX_CLI_NAME,
          metadata: {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            ...(sandboxLog?.metadata ?? {}),
          },
        };
      }

      const parsed = extractCodexExecResult(result.stdout);
      const sandboxLog = readSandboxLogBreadcrumb();
      console.log(
        formatCodexRunLogLine({
          phase: 'success',
          runId: input.runId,
          action: input.action,
          issueNumber: input.projection.issue.number,
          repo: input.projection.issue.repo,
          recentEventIds: input.recentEvents.map((event) => event.eventId),
          model,
          ...(input.workspacePath === undefined
            ? {}
            : { workspacePath: input.workspacePath }),
          ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
        }),
      );

      return {
        result: parsed.result,
        model,
        cli: CODEX_CLI_NAME,
        ...(parsed.sessionId === undefined ? {} : { session_id: parsed.sessionId }),
        ...(parsed.tokenUsage === undefined ? {} : { tokenUsage: parsed.tokenUsage }),
        metadata: {
          stdout: result.stdout,
          stderr: result.stderr,
          raw: result.stdout
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>),
          skipApproval: stagePrompt.skipApproval,
          ...(sandboxLog?.metadata ?? {}),
        },
      };
    },
    async smoke(): Promise<{
      text: string;
      sessionId?: string;
      stdout: string;
      stderr: string;
      exitCode: number;
    }> {
      const result = await runAgentCliCommand({
        command: options.command,
        args: buildCodexExecArgs({
          model: options.settings.smokeModel,
          prompt: options.settings.smokePrompt,
          cwd: options.cwd,
          sandboxMode: 'danger-full-access',
          ...(options.settings.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: options.settings.reasoningEffort }),
        }),
        cwd: options.cwd,
      });

      const parsed =
        result.exitCode === 0 && result.stdout.trim().length > 0
          ? extractCodexExecResult(result.stdout)
          : undefined;

      return {
        text: parsed?.result ?? '',
        ...(parsed?.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  };
}
