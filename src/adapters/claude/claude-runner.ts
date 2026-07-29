import type { AgentRunInput, AgentRunResult, AgentRunTokenUsage } from '../../core/contracts.js';
import { parseClaudePrintResult, parseRunnerResult } from '../../domain/schema.js';
import type { AgentAction, ClaudePrintResult, RunnerEntry } from '../../domain/types.js';

type ClaudeRunnerSettings = Omit<Extract<RunnerEntry, { kind: 'claude' }>, 'kind'> & {
  timeoutMs: number;
  gracefulCancellationTimeoutMs: number;
};
import { runAgentCliCommand } from '../runner/cli-command.js';
import { buildStagePrompt, sentinelListForApproval } from '../runner/stage-prompt.js';
import { emitRuntimeEvent, runnerRuntimeEvent } from '../runner/runtime-events.js';
import { writeRunnerTranscript } from '../runner/transcripts.js';
import { createAgentExecution } from '../../core/live-execution.js';

export { buildStagePrompt } from '../runner/stage-prompt.js';

function slugify(value: string, maxLength = 40): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

export function buildWakeSessionName(input: {
  sessionName: string;
  issueNumber: number;
  title: string;
  runId: string;
}): string {
  return [input.sessionName, `issue-${input.issueNumber}`, slugify(input.title), input.runId]
    .filter((part) => part.length > 0)
    .join('-');
}

function compactLogValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function formatClaudeRunLogLine(input: {
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
    '[claude-run]',
    `phase=${input.phase}`,
    `runId=${input.runId}`,
    `cli=Claude`,
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

export function buildClaudePrintArgs(options: {
  model: string;
  prompt: string;
  systemPrompt?: string;
  sessionName: string;
  permissionMode?: string;
  allowedTools?: string[];
  remoteControlName?: string;
  extraArgs?: string[];
  maxTurns?: number;
  effort?: string;
  resumeSessionId?: string;
}): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    options.model,
    '--name',
    options.sessionName,
    ...(options.resumeSessionId === undefined ? [] : ['--resume', options.resumeSessionId]),
    ...(options.effort === undefined ? [] : ['--effort', options.effort]),
    ...(options.systemPrompt === undefined ? [] : ['--append-system-prompt', options.systemPrompt]),
    ...(options.maxTurns === undefined ? [] : ['--max-turns', String(options.maxTurns)]),
    ...(options.permissionMode === undefined ? [] : ['--permission-mode', options.permissionMode]),
    ...(options.allowedTools === undefined || options.allowedTools.length === 0
      ? []
      : ['--allowedTools', options.allowedTools.join(' ')]),
    ...(options.remoteControlName === undefined
      ? []
      : ['--remote-control', options.remoteControlName]),
    // Generic escape hatch for any other CLI flag a stage template needs
    // (e.g. --dangerously-skip-permissions) without bespoke code per flag.
    ...(options.extraArgs ?? []),
    // Terminate option parsing so the prompt is never swallowed by a
    // variadic/optional-value flag above (e.g. --allowedTools, --remote-control,
    // or anything in extraArgs with an optional value).
    '--',
    options.prompt,
  ];
}

export function buildClaudeRemoteControlArgs(options: {
  model: string;
  prompt: string;
  remoteControlName: string;
  sessionName: string;
}): string[] {
  return [
    '--bg',
    '--remote-control',
    options.remoteControlName,
    '--model',
    options.model,
    '--name',
    options.sessionName,
    options.prompt,
  ];
}

export function runClaudeCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  gracefulCancellationTimeoutMs?: number;
  cancellationSignal?: AbortSignal;
  onProcessStart?: (identity: { pid: number; processStartedAt: string }) => Promise<void>;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  canceled: boolean;
}> {
  return runAgentCliCommand(input);
}

function resolveModel(options: { action: AgentAction; settings: ClaudeRunnerSettings }): string {
  return options.settings.model;
}

function parseClaudePrintOutput(stdout: string): ClaudePrintResult {
  return parseClaudePrintResult(JSON.parse(stdout));
}

function extractTokenUsage(parsed: ClaudePrintResult): AgentRunTokenUsage | undefined {
  const usage = parsed.usage;
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const cacheCreationInputTokens =
    typeof usage.cache_creation_input_tokens === 'number'
      ? usage.cache_creation_input_tokens
      : undefined;
  const cacheReadInputTokens =
    typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(parsed.total_cost_usd === undefined ? {} : { costUsd: parsed.total_cost_usd }),
    ...(parsed.num_turns === undefined ? {} : { turns: parsed.num_turns }),
  };
}

const CLAUDE_CLI_NAME = 'Claude';

// Bounded — this is a single "just tell me the status" follow-up, not a
// second attempt at the task, so it never needs more than one turn.
const ENVELOPE_REPAIR_MAX_TURNS = 1;
const ENVELOPE_REPAIR_TIMEOUT_MS = 60_000;

function buildEnvelopeRepairPrompt(reviewShaped: boolean): string {
  return [
    'Your previous reply did not end with the required `wake-result` envelope, so it could not be parsed.',
    'Reply with ONLY a fenced `wake-result` JSON block containing a `status` field, then repeat that status word on its own line after the closing fence.',
    `The status must be exactly one of: ${sentinelListForApproval(reviewShaped)}, reflecting the outcome of your previous turn.`,
    'Do not repeat, summarize, or redo any of your previous work — this reply is parsed automatically and anything besides the envelope is discarded.',
  ].join('\n');
}

function mergeTokenUsage(
  base: AgentRunTokenUsage | undefined,
  extra: AgentRunTokenUsage | undefined,
): AgentRunTokenUsage | undefined {
  if (extra === undefined) {
    return base;
  }
  if (base === undefined) {
    return extra;
  }
  return {
    inputTokens: base.inputTokens + extra.inputTokens,
    outputTokens: base.outputTokens + extra.outputTokens,
    ...(base.cacheCreationInputTokens === undefined && extra.cacheCreationInputTokens === undefined
      ? {}
      : {
          cacheCreationInputTokens:
            (base.cacheCreationInputTokens ?? 0) + (extra.cacheCreationInputTokens ?? 0),
        }),
    ...(base.cacheReadInputTokens === undefined && extra.cacheReadInputTokens === undefined
      ? {}
      : {
          cacheReadInputTokens:
            (base.cacheReadInputTokens ?? 0) + (extra.cacheReadInputTokens ?? 0),
        }),
    ...(base.costUsd === undefined && extra.costUsd === undefined
      ? {}
      : { costUsd: (base.costUsd ?? 0) + (extra.costUsd ?? 0) }),
    ...(base.turns === undefined && extra.turns === undefined
      ? {}
      : { turns: (base.turns ?? 0) + (extra.turns ?? 0) }),
  };
}

// Asks the same (still-live) session to restate just its result envelope,
// for the case where a run otherwise completed but the model forgot the
// mandatory trailer — cheaper and more honest than defaulting the whole run
// to BLOCKED because of a formatting slip. Returns undefined on any failure
// so the caller falls back to the original (unparseable) result untouched.
async function attemptEnvelopeRepair(input: {
  command: string;
  cwd: string;
  model: string;
  sessionName: string;
  sessionId: string;
  reviewShaped: boolean;
  timeoutMs: number;
  gracefulCancellationTimeoutMs?: number;
}): Promise<{ text: string; tokenUsage?: AgentRunTokenUsage } | undefined> {
  const args = buildClaudePrintArgs({
    model: input.model,
    prompt: buildEnvelopeRepairPrompt(input.reviewShaped),
    sessionName: input.sessionName,
    resumeSessionId: input.sessionId,
    maxTurns: ENVELOPE_REPAIR_MAX_TURNS,
  });

  const result = await runClaudeCommand({
    command: input.command,
    args,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    ...(input.gracefulCancellationTimeoutMs === undefined
      ? {}
      : { gracefulCancellationTimeoutMs: input.gracefulCancellationTimeoutMs }),
  });

  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.canceled ||
    result.stdout.trim().length === 0
  ) {
    return undefined;
  }

  try {
    const parsed = parseClaudePrintOutput(result.stdout);
    const repairTokenUsage = extractTokenUsage(parsed);
    return {
      text: parsed.result,
      ...(repairTokenUsage === undefined ? {} : { tokenUsage: repairTokenUsage }),
    };
  } catch {
    return undefined;
  }
}

export function classifyClaudeCliFailure(input: {
  stderr: string;
  stdout: string;
  timedOut: boolean;
}): 'quota' | 'infra' {
  if (input.timedOut) {
    return 'infra';
  }

  const text = `${input.stderr}\n${input.stdout}`.toLowerCase();
  if (
    text.includes('rate limit') ||
    text.includes('quota') ||
    text.includes('billing') ||
    text.includes('credit balance') ||
    text.includes('spend limit') ||
    text.includes('usage limit') ||
    text.includes('session limit') ||
    text.includes('too many requests') ||
    text.includes('authentication') ||
    text.includes('unauthorized') ||
    text.includes('permission denied')
  ) {
    return 'quota';
  }

  return 'infra';
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

export function createClaudeRunner(options: {
  command: string;
  cwd: string;
  settings: ClaudeRunnerSettings;
}) {
  async function executeRun(input: AgentRunInput): Promise<AgentRunResult> {
    const sessionName = buildWakeSessionName({
      sessionName: options.settings.sessionName,
      issueNumber: input.projection.issue.number,
      title: input.projection.issue.title,
      runId: input.runId,
    });

    // Resume an in-progress session when the projection carries a session ID
    // that was created by this same CLI. This happens when the previous run
    // ended with BLOCKED and the same action is being retried after a human
    // reply. Any forward-stage transition or FAILED run clears the stored
    // session ID so that the next action always starts fresh.
    const priorSessionId = input.projection.wake.sessionId;
    const priorSessionCli = input.projection.wake.sessionCli;
    const isResume = priorSessionId !== undefined && priorSessionCli === CLAUDE_CLI_NAME;

    const stagePrompt = await buildStagePrompt({
      action: input.action,
      projection: input.projection,
      mode: isResume ? 'resume' : 'start',
      config: input.config,
      ...(input.promptContextOverrides === undefined
        ? {}
        : { contextOverrides: input.promptContextOverrides }),
      ...(input.mergeConflictDetected === true ? { mergeConflictDetected: true } : {}),
      ...(input.upstreamChanges === undefined ? {} : { upstreamChanges: input.upstreamChanges }),
      ...(input.preExistingUncommittedChanges === true
        ? { preExistingUncommittedChanges: true }
        : {}),
    });

    const model = resolveModel({
      action: input.action,
      settings: options.settings,
    });

    const args = buildClaudePrintArgs({
      model,
      prompt: stagePrompt.prompt,
      systemPrompt: stagePrompt.harnessPrompt,
      sessionName,
      allowedTools: stagePrompt.allowedTools,
      extraArgs: stagePrompt.extraArgs,
      maxTurns: stagePrompt.maxTurns,
      ...(stagePrompt.permissionMode === undefined
        ? {}
        : { permissionMode: stagePrompt.permissionMode }),
      ...(options.settings.remoteControl.enabled ? { remoteControlName: sessionName } : {}),
      ...(options.settings.effort === undefined ? {} : { effort: options.settings.effort }),
      ...(isResume ? { resumeSessionId: priorSessionId } : {}),
    });
    const promptTranscriptPath = await writeRunnerTranscript({
      config: input.config,
      projection: input.projection,
      runId: input.runId,
      action: input.action,
      cli: CLAUDE_CLI_NAME,
      kind: 'prompt',
      text: stagePrompt.prompt,
    });

    console.log(
      formatClaudeRunLogLine({
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

    const result = await runClaudeCommand({
      command: options.command,
      args,
      cwd: input.workspacePath ?? options.cwd,
      timeoutMs: options.settings.timeoutMs,
      gracefulCancellationTimeoutMs: options.settings.gracefulCancellationTimeoutMs,
      ...(input.cancellationSignal === undefined
        ? {}
        : { cancellationSignal: input.cancellationSignal }),
      onProcessStart: async (identity) => {
        await input.onProcessStart?.(identity);
        await emitRuntimeEvent(
          input.onRuntimeEvent,
          runnerRuntimeEvent({
            type: 'agent.process.started',
            runId: input.runId,
            projection: input.projection,
            routing: input.routing,
            cli: CLAUDE_CLI_NAME,
            model,
            payload: { pid: identity.pid, processStartedAt: identity.processStartedAt },
          }),
        );
      },
    });
    const responseTranscriptPath = await writeRunnerTranscript({
      config: input.config,
      projection: input.projection,
      runId: input.runId,
      action: input.action,
      cli: CLAUDE_CLI_NAME,
      kind: 'response',
      text: result.stdout,
    });

    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.canceled ||
      result.stdout.trim().length === 0
    ) {
      const sandboxLog = readSandboxLogBreadcrumb();
      const failureClass = classifyClaudeCliFailure({
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      });
      console.error(
        formatClaudeRunLogLine({
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
      await emitRuntimeEvent(
        input.onRuntimeEvent,
        runnerRuntimeEvent({
          type: 'agent.process.exited',
          runId: input.runId,
          projection: input.projection,
          routing: input.routing,
          cli: CLAUDE_CLI_NAME,
          model,
          payload: {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            canceled: result.canceled,
          },
        }),
      );
      let parsedReason: string | undefined;
      let stdoutFailureDetail: string | undefined;
      const trimmedStdout = result.stdout.trim();
      try {
        if (trimmedStdout.length > 0) {
          parsedReason = parseClaudePrintOutput(result.stdout).result;
        }
      } catch {
        // stdout wasn't valid JSON, so it is likely a CLI-level error
        // message rather than a Claude print result.
        stdoutFailureDetail = trimmedStdout;
      }
      return {
        result: [
          result.timedOut
            ? `Claude runner timed out after ${options.settings.timeoutMs}ms and was killed`
            : result.canceled
              ? 'Claude runner was canceled'
              : trimmedStdout.length === 0
                ? 'Claude runner produced no output'
                : parsedReason !== undefined
                  ? `Claude runner failed: ${parsedReason}`
                  : 'Claude runner failed',
          result.stderr,
          stdoutFailureDetail,
          sandboxLog?.text,
          'FAILED',
        ]
          .filter((part) => part !== undefined && part.length > 0)
          .join('\n'),
        model,
        cli: CLAUDE_CLI_NAME,
        failureClass,
        metadata: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          canceled: result.canceled,
          failureClass,
          ...(promptTranscriptPath === undefined ? {} : { promptTranscriptPath }),
          ...(responseTranscriptPath === undefined ? {} : { responseTranscriptPath }),
          ...(sandboxLog?.metadata ?? {}),
        },
      };
    }

    const parsed = parseClaudePrintOutput(result.stdout);
    const sandboxLog = readSandboxLogBreadcrumb();
    await emitRuntimeEvent(
      input.onRuntimeEvent,
      runnerRuntimeEvent({
        type: 'agent.progress',
        runId: input.runId,
        projection: input.projection,
        routing: input.routing,
        cli: CLAUDE_CLI_NAME,
        model,
        ...(parsed.session_id === undefined ? {} : { sessionId: parsed.session_id }),
        payload: { message: 'Claude print result received', raw: parsed },
      }),
    );
    console.log(
      formatClaudeRunLogLine({
        phase: 'success',
        runId: input.runId,
        action: input.action,
        issueNumber: input.projection.issue.number,
        repo: input.projection.issue.repo,
        recentEventIds: input.recentEvents.map((event) => event.eventId),
        model,
        ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
        ...(parsed.session_id === undefined ? {} : { sessionId: parsed.session_id }),
      }),
    );
    const tokenUsage = extractTokenUsage(parsed);

    let effectiveResultText = parsed.result;
    let effectiveTokenUsage = tokenUsage;
    let envelopeRepaired = false;
    if (
      parseRunnerResult(effectiveResultText).envelope === 'missing' &&
      parsed.session_id !== undefined
    ) {
      const repair = await attemptEnvelopeRepair({
        command: options.command,
        cwd: input.workspacePath ?? options.cwd,
        model,
        sessionName,
        sessionId: parsed.session_id,
        reviewShaped: stagePrompt.reviewShaped,
        timeoutMs: Math.min(options.settings.timeoutMs, ENVELOPE_REPAIR_TIMEOUT_MS),
        gracefulCancellationTimeoutMs: options.settings.gracefulCancellationTimeoutMs,
      });
      if (repair !== undefined && parseRunnerResult(repair.text).envelope !== 'missing') {
        effectiveResultText = `${effectiveResultText.trimEnd()}\n\n${repair.text.trim()}`;
        effectiveTokenUsage = mergeTokenUsage(effectiveTokenUsage, repair.tokenUsage);
        envelopeRepaired = true;
        console.log(
          `[claude-run] envelope repair succeeded runId=${input.runId} sessionId=${parsed.session_id}`,
        );
      } else {
        console.error(
          `[claude-run] envelope repair failed runId=${input.runId} sessionId=${parsed.session_id}`,
        );
      }
    }

    if (tokenUsage !== undefined) {
      await emitRuntimeEvent(
        input.onRuntimeEvent,
        runnerRuntimeEvent({
          type: 'agent.usage.updated',
          runId: input.runId,
          projection: input.projection,
          routing: input.routing,
          cli: CLAUDE_CLI_NAME,
          model,
          ...(parsed.session_id === undefined ? {} : { sessionId: parsed.session_id }),
          payload: { tokenUsage },
        }),
      );
    }
    await emitRuntimeEvent(
      input.onRuntimeEvent,
      runnerRuntimeEvent({
        type: 'agent.process.exited',
        runId: input.runId,
        projection: input.projection,
        routing: input.routing,
        cli: CLAUDE_CLI_NAME,
        model,
        ...(parsed.session_id === undefined ? {} : { sessionId: parsed.session_id }),
        payload: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          canceled: result.canceled,
        },
      }),
    );
    return {
      result: effectiveResultText,
      model,
      cli: CLAUDE_CLI_NAME,
      ...(parseRunnerResult(effectiveResultText).status === 'FAILED'
        ? { failureClass: 'task' as const }
        : {}),
      ...(parsed.session_id === undefined ? {} : { session_id: parsed.session_id }),
      ...(effectiveTokenUsage === undefined ? {} : { tokenUsage: effectiveTokenUsage }),
      metadata: {
        stdout: result.stdout,
        stderr: result.stderr,
        raw: parsed,
        skipApproval: stagePrompt.skipApproval,
        allowAutoApproval: stagePrompt.allowAutoApproval,
        ...(envelopeRepaired ? { envelopeRepaired: true } : {}),
        ...(promptTranscriptPath === undefined ? {} : { promptTranscriptPath }),
        ...(responseTranscriptPath === undefined ? {} : { responseTranscriptPath }),
        ...(sandboxLog?.metadata ?? {}),
      },
    };
  }

  return {
    async start(input: AgentRunInput) {
      return createAgentExecution(input, executeRun);
    },
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      return (await this.start(input)).result;
    },
    async smoke(): Promise<{
      text: string;
      sessionId?: string;
      stdout: string;
      stderr: string;
      exitCode: number;
    }> {
      const args = buildClaudePrintArgs({
        model: options.settings.smokeModel,
        prompt: options.settings.smokePrompt,
        sessionName: options.settings.sessionName,
      });

      const result = await runClaudeCommand({
        command: options.command,
        args,
        cwd: options.cwd,
      });

      const parsed =
        result.exitCode === 0 && result.stdout.trim().length > 0
          ? parseClaudePrintOutput(result.stdout)
          : undefined;

      return {
        text: parsed?.result ?? '',
        ...(parsed?.session_id === undefined ? {} : { sessionId: parsed.session_id }),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
    async startRemoteControlSmoke(): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      command: string;
      args: string[];
    }> {
      const args = buildClaudeRemoteControlArgs({
        model: options.settings.smokeModel,
        prompt: options.settings.smokePrompt,
        remoteControlName: options.settings.remoteControlName,
        sessionName: options.settings.sessionName,
      });

      const result = await runClaudeCommand({
        command: options.command,
        args,
        cwd: options.cwd,
      });

      return {
        ...result,
        command: options.command,
        args,
      };
    },
  };
}
