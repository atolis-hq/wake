/**
 * Codex runner notes and known parity gaps vs Claude:
 *
 * - Codex supports real non-interactive runs, resume, approval policy, sandbox
 *   mode, cwd selection, and JSONL event output, so Wake maps those directly.
 * - Codex does NOT expose a Claude-equivalent `--max-turns` cap for `exec`, so
 *   Wake cannot enforce `maxTurns` at the CLI boundary for this runner today.
 * - Codex does NOT expose a Claude-equivalent local-tool allowlist such as
 *   `--allowedTools`. Wake still renders the same stage prompt restrictions, but
 *   read-only stage tool limits are prompt-guided plus sandbox-limited, not
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
import { writeRunnerTranscript } from '../runner/transcripts.js';
import { parseRunnerResult } from '../../domain/schema.js';

const CODEX_CLI_NAME = 'Codex';

export function buildCodexExecArgs(input: {
  model: string;
  prompt: string;
  harnessPrompt?: string;
  cwd: string;
  sandboxMode: 'workspace-write' | 'danger-full-access';
  reasoningEffort?: string;
}): string[] {
  const prompt = buildCodexPromptText(input);

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

export function buildCodexPromptText(input: { prompt: string; harnessPrompt?: string }): string {
  return input.harnessPrompt === undefined
    ? input.prompt
    : `${input.harnessPrompt}\n\n${input.prompt}`;
}

export function buildCodexResumeArgs(input: { sessionId: string }): string[] {
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
    `recentEventIds=${input.recentEventIds.length > 0 ? input.recentEventIds.join(',') : '(none)'}`,
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
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let sawUsage = false;

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
        sawUsage = true;
        turns += 1;
        // Each `turn.completed` reports that turn's own usage (an exec run can
        // make several model turns via tool calls), so accumulate across turns
        // rather than keeping only the last one - otherwise a multi-turn run's
        // reported usage undercounts the actual spend (#135).
        inputTokens += typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
        outputTokens += typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
        // OpenAI's Responses API reports cached prompt tokens nested under
        // input_tokens_details.cached_tokens; unverified against a live Codex
        // success response (this environment's Codex quota was exhausted while
        // this adapter was written), so it is read defensively and simply
        // omitted if absent rather than assumed to exist.
        const inputTokensDetails = usage.input_tokens_details as
          Record<string, unknown> | undefined;
        if (typeof inputTokensDetails?.cached_tokens === 'number') {
          cachedInputTokens += inputTokensDetails.cached_tokens;
        }
      }
    }
  }

  if (result === undefined) {
    throw new Error('Codex exec JSONL stream did not include a final agent message.');
  }

  const tokenUsage: AgentRunTokenUsage | undefined = sawUsage
    ? {
        inputTokens,
        outputTokens,
        turns,
        ...(cachedInputTokens > 0 ? { cacheReadInputTokens: cachedInputTokens } : {}),
      }
    : undefined;

  return {
    result,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  };
}

// Codex exec emits a JSONL stream even on failure (unlike a bare CLI crash,
// which produces no JSON at all). Reading the structured `message` field off
// `error`/`turn.failed` events is more reliable than grepping the raw stdout
// blob, and it is also the string that carries the actual reset-time hint
// (e.g. "...or try again at 2:29 PM") that quota-backoff needs.
export function extractCodexErrorMessage(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'error' && typeof event.message === 'string') {
      return event.message;
    }
    if (event.type === 'turn.failed') {
      const error = event.error as Record<string, unknown> | undefined;
      if (typeof error?.message === 'string') {
        return error.message;
      }
    }
  }
  return undefined;
}

export function classifyCodexCliFailure(input: {
  stderr: string;
  stdout: string;
  timedOut: boolean;
}): 'quota' | 'infra' {
  if (input.timedOut) {
    return 'infra';
  }

  const structuredMessage = extractCodexErrorMessage(input.stdout);
  const text = (structuredMessage ?? `${input.stderr}\n${input.stdout}`).toLowerCase();
  if (
    text.includes('usage limit') ||
    text.includes('rate limit') ||
    text.includes('quota') ||
    text.includes('billing') ||
    text.includes('credit') ||
    text.includes('too many requests') ||
    text.includes('unauthorized') ||
    text.includes('authentication')
  ) {
    return 'quota';
  }

  return 'infra';
}

function resolveModel(input: { action: AgentAction; settings: CodexRunnerSettings }): string {
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

function readSandboxLogBreadcrumb(): {
  text: string;
  metadata: { sandboxContainerName: string };
} | null {
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
  workspaceMode?: 'none' | 'read-only' | 'branch';
}): 'workspace-write' | 'danger-full-access' {
  return input.workspaceMode === 'branch' ? 'danger-full-access' : 'workspace-write';
}

// Codex uses shell execution rather than Claude Code's named tools (Read/Glob/Grep).
// For read-only stages, override the tool capability note so the agent is told what it
// can actually use instead of Claude-specific tool names it does not have.
export function buildCodexToolCapabilityNote(input: {
  workspaceMode?: 'none' | 'read-only' | 'branch';
  mode: 'start' | 'resume';
}): string | undefined {
  if (input.workspaceMode !== 'read-only') {
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
      workspaceMode?: 'none' | 'read-only' | 'branch';
      workspacePath?: string;
      mergeConflictDetected?: boolean;
      upstreamChanges?: string;
    }): Promise<AgentRunResult> {
      const runMode = 'start';
      const toolCapabilityNote = buildCodexToolCapabilityNote({
        ...(input.workspaceMode === undefined ? {} : { workspaceMode: input.workspaceMode }),
        mode: runMode,
      });
      const stagePrompt = await buildStagePrompt({
        action: input.action,
        projection: input.projection,
        mode: runMode,
        config: input.config,
        ...(input.workspaceMode === undefined ? {} : { workspaceMode: input.workspaceMode }),
        ...(input.mergeConflictDetected === true ? { mergeConflictDetected: true } : {}),
        ...(input.upstreamChanges === undefined ? {} : { upstreamChanges: input.upstreamChanges }),
        ...(toolCapabilityNote !== undefined ? { contextOverrides: { toolCapabilityNote } } : {}),
      });

      const model = resolveModel({
        action: input.action,
        settings: options.settings,
      });

      const cwd = input.workspacePath ?? options.cwd;
      const sandboxMode = resolveSandboxMode({
        ...(input.workspaceMode === undefined ? {} : { workspaceMode: input.workspaceMode }),
      });
      const promptText = buildCodexPromptText({
        prompt: stagePrompt.prompt,
        harnessPrompt: stagePrompt.harnessPrompt,
      });
      const promptTranscriptPath = await writeRunnerTranscript({
        config: input.config,
        projection: input.projection,
        runId: input.runId,
        action: input.action,
        cli: CODEX_CLI_NAME,
        kind: 'prompt',
        text: promptText,
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
          ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
        }),
      );
      const result = await runAgentCliCommand({
        command: options.command,
        args: buildCodexExecArgs({
          model,
          prompt: promptText,
          cwd,
          sandboxMode,
          ...(options.settings.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: options.settings.reasoningEffort }),
        }),
        cwd,
        timeoutMs: options.settings.timeoutMs,
      });
      const responseTranscriptPath = await writeRunnerTranscript({
        config: input.config,
        projection: input.projection,
        runId: input.runId,
        action: input.action,
        cli: CODEX_CLI_NAME,
        kind: 'response',
        text: result.stdout,
      });

      if (result.exitCode !== 0 || result.timedOut || result.stdout.trim().length === 0) {
        const sandboxLog = readSandboxLogBreadcrumb();
        const failureClass = classifyCodexCliFailure({
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
        });
        const structuredMessage = result.timedOut
          ? undefined
          : extractCodexErrorMessage(result.stdout);
        console.error(
          formatCodexRunLogLine({
            phase: 'failure',
            runId: input.runId,
            action: input.action,
            issueNumber: input.projection.issue.number,
            repo: input.projection.issue.repo,
            recentEventIds: input.recentEvents.map((event) => event.eventId),
            model,
            ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
            exitCode: result.exitCode,
          }),
        );
        return {
          result: [
            result.timedOut
              ? `Codex runner timed out after ${options.settings.timeoutMs}ms and was killed`
              : structuredMessage !== undefined
                ? `Codex runner failed: ${structuredMessage}`
                : result.stdout.trim().length === 0
                  ? 'Codex runner produced no output'
                  : 'Codex runner failed',
            result.stderr,
            sandboxLog?.text,
            'FAILED',
          ]
            .filter((part) => part !== undefined && part.length > 0)
            .join('\n'),
          model,
          cli: CODEX_CLI_NAME,
          failureClass,
          metadata: {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            failureClass,
            ...(promptTranscriptPath === undefined ? {} : { promptTranscriptPath }),
            ...(responseTranscriptPath === undefined ? {} : { responseTranscriptPath }),
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
          ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
          ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
        }),
      );

      return {
        result: parsed.result,
        model,
        cli: CODEX_CLI_NAME,
        ...(parseRunnerResult(parsed.result).status === 'FAILED'
          ? { failureClass: 'task' as const }
          : {}),
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
          ...(promptTranscriptPath === undefined ? {} : { promptTranscriptPath }),
          ...(responseTranscriptPath === undefined ? {} : { responseTranscriptPath }),
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
