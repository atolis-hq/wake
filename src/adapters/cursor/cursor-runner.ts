/**
 * Cursor runner notes and known parity gaps vs Claude:
 *
 * - Cursor supports real non-interactive runs (agent -p), JSON output
 *   (--output-format json), and session resume (--resume=<id>), so Wake maps
 *   those directly.
 * - Cursor's `--mode ask` enforces read-only access at the CLI boundary for
 *   refine-stage runs; `--force` auto-approves writes for implement-stage runs.
 * - Cursor does NOT expose a Claude-equivalent `--max-turns` cap, so Wake
 *   cannot enforce `maxTurns` at the CLI boundary for this runner today.
 * - Cursor does NOT expose a Claude-equivalent per-tool allowlist such as
 *   `--allowedTools`. Refine-stage confinement relies on `--mode ask` plus
 *   prompt guidance rather than per-tool granularity.
 * - Cursor session naming is not supported via a CLI flag.
 * - Cursor remote-control is not available from the CLI; the path is desktop
 *   app-driven only.
 *
 * Keep this comment aligned with docs/runner-comparison.md when the adapter or
 * public CLI surface changes.
 */
import type { AgentRunResult } from '../../core/contracts.js';
import type {
  AgentAction,
  EventEnvelope,
  IssueStateRecord,
  RunnerEntry,
  WakeConfig,
} from '../../domain/types.js';
import { parseRunnerResult } from '../../domain/schema.js';
import { buildStagePrompt } from '../runner/stage-prompt.js';
import { runAgentCliCommand } from '../runner/cli-command.js';

type CursorRunnerSettings = Omit<Extract<RunnerEntry, { kind: 'cursor' }>, 'kind'>;

const CURSOR_CLI_NAME = 'Cursor';

export function buildCursorAgentArgs(input: {
  model: string;
  prompt: string;
  harnessPrompt?: string;
  mode?: 'ask' | 'agent';
  force?: boolean;
  resumeSessionId?: string;
}): string[] {
  const fullPrompt =
    input.harnessPrompt === undefined
      ? input.prompt
      : `${input.harnessPrompt}\n\n${input.prompt}`;

  return [
    'agent',
    '-p',
    '--output-format',
    'json',
    '--model',
    input.model,
    ...(input.mode !== undefined ? ['--mode', input.mode] : []),
    ...(input.force === true ? ['--force'] : []),
    ...(input.resumeSessionId !== undefined ? [`--resume=${input.resumeSessionId}`] : []),
    fullPrompt,
  ];
}

export function buildCursorResumeArgs(input: { sessionId: string }): string[] {
  return ['agent', '--resume=' + input.sessionId];
}

function compactLogValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function formatCursorRunLogLine(input: {
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
    '[cursor-run]',
    `phase=${input.phase}`,
    `runId=${input.runId}`,
    `cli=Cursor`,
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

export function extractCursorAgentResult(stdout: string): {
  result: string;
  sessionId?: string;
  isError?: boolean;
} {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error('Cursor agent produced no output.');
  }

  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  const result = typeof parsed.result === 'string' ? parsed.result : undefined;

  if (result === undefined) {
    throw new Error('Cursor agent JSON output did not include a result field.');
  }

  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined;
  const isError = typeof parsed.is_error === 'boolean' ? parsed.is_error : undefined;

  return {
    result,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(isError !== undefined ? { isError } : {}),
  };
}

export function classifyCursorCliFailure(input: {
  stderr: string;
  stdout: string;
  timedOut: boolean;
  isError?: boolean;
}): 'task' | 'quota' | 'infra' {
  if (input.timedOut) {
    return 'infra';
  }

  // Cursor JSON output signals a handled task-level error
  if (input.isError === true) {
    return 'task';
  }

  const text = `${input.stderr}\n${input.stdout}`.toLowerCase();
  if (
    text.includes('rate limit') ||
    text.includes('quota') ||
    text.includes('billing') ||
    text.includes('unauthorized') ||
    text.includes('authentication') ||
    text.includes('api key') ||
    text.includes('too many requests')
  ) {
    return 'quota';
  }

  return 'infra';
}

// Cursor uses --mode ask for read-only refine stages, which already enforces
// the constraint at the CLI boundary. The capability note explains to the agent
// what tools are available in ask mode versus agent mode.
export function buildCursorToolCapabilityNote(input: {
  action: AgentAction;
  mode: 'start' | 'resume';
}): string | undefined {
  if (input.action !== 'refine') {
    return undefined;
  }
  const note =
    'You are running in read-only ask mode. You can read and explore the repository but cannot modify files. ' +
    'Use your available file-reading and search tools to understand the codebase.';
  return input.mode === 'resume' ? `Reminder: this is still a planning-only stage. ${note}` : note;
}

function resolveCursorMode(input: { action: AgentAction }): 'ask' | 'agent' {
  return input.action === 'refine' ? 'ask' : 'agent';
}

function resolveModel(input: {
  action: AgentAction;
  settings: CursorRunnerSettings;
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

export function createCursorRunner(options: {
  command: string;
  cwd: string;
  settings: CursorRunnerSettings;
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
      const priorSessionId = input.projection.wake.sessionId;
      const priorSessionCli = input.projection.wake.sessionCli;
      const isResume = priorSessionId !== undefined && priorSessionCli === CURSOR_CLI_NAME;

      const cursorMode = resolveCursorMode({ action: input.action });
      const toolCapabilityNote = buildCursorToolCapabilityNote({
        action: input.action,
        mode: isResume ? 'resume' : 'start',
      });

      const stagePrompt = await buildStagePrompt({
        action: input.action,
        projection: input.projection,
        mode: isResume ? 'resume' : 'start',
        config: input.config,
        ...(toolCapabilityNote !== undefined ? { contextOverrides: { toolCapabilityNote } } : {}),
      });

      const model = resolveModel({ action: input.action, settings: options.settings });
      const cwd = input.workspacePath ?? options.cwd;

      console.log(
        formatCursorRunLogLine({
          phase: 'start',
          runId: input.runId,
          action: input.action,
          issueNumber: input.projection.issue.number,
          repo: input.projection.issue.repo,
          recentEventIds: input.recentEvents.map((event) => event.eventId),
          model,
          ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
          ...(isResume ? { sessionId: priorSessionId } : {}),
        }),
      );

      const result = await runAgentCliCommand({
        command: options.command,
        args: buildCursorAgentArgs({
          model,
          prompt: stagePrompt.prompt,
          harnessPrompt: stagePrompt.harnessPrompt,
          mode: cursorMode,
          force: cursorMode === 'agent',
          ...(isResume ? { resumeSessionId: priorSessionId } : {}),
        }),
        cwd,
        timeoutMs: options.settings.timeoutMs,
      });

      if (result.exitCode !== 0 || result.timedOut || result.stdout.trim().length === 0) {
        const sandboxLog = readSandboxLogBreadcrumb();
        const failureClass = classifyCursorCliFailure({
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
        });
        console.error(
          formatCursorRunLogLine({
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
              ? `Cursor runner timed out after ${options.settings.timeoutMs}ms and was killed`
              : result.stdout.trim().length === 0
                ? 'Cursor runner produced no output'
                : 'Cursor runner failed',
            result.stderr,
            sandboxLog?.text,
            'FAILED',
          ]
            .filter((part) => part !== undefined && part.length > 0)
            .join('\n'),
          model,
          cli: CURSOR_CLI_NAME,
          failureClass,
          metadata: {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            failureClass,
            ...(sandboxLog?.metadata ?? {}),
          },
        };
      }

      let parsed: ReturnType<typeof extractCursorAgentResult>;
      try {
        parsed = extractCursorAgentResult(result.stdout);
      } catch (err) {
        const sandboxLog = readSandboxLogBreadcrumb();
        return {
          result: [`Cursor runner output could not be parsed: ${String(err)}`, 'FAILED']
            .filter((part) => part.length > 0)
            .join('\n'),
          model,
          cli: CURSOR_CLI_NAME,
          failureClass: 'infra',
          metadata: {
            stdout: result.stdout,
            stderr: result.stderr,
            parseError: String(err),
            ...(sandboxLog?.metadata ?? {}),
          },
        };
      }

      const sandboxLog = readSandboxLogBreadcrumb();
      console.log(
        formatCursorRunLogLine({
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
        cli: CURSOR_CLI_NAME,
        ...(parseRunnerResult(parsed.result).status === 'FAILED'
          ? { failureClass: 'task' as const }
          : {}),
        ...(parsed.sessionId === undefined ? {} : { session_id: parsed.sessionId }),
        metadata: {
          stdout: result.stdout,
          stderr: result.stderr,
          raw: parsed,
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
        args: buildCursorAgentArgs({
          model: options.settings.smokeModel,
          prompt: options.settings.smokePrompt,
          mode: 'agent',
          force: true,
        }),
        cwd: options.cwd,
      });

      let parsed: ReturnType<typeof extractCursorAgentResult> | undefined;
      if (result.exitCode === 0 && result.stdout.trim().length > 0) {
        try {
          parsed = extractCursorAgentResult(result.stdout);
        } catch {
          parsed = undefined;
        }
      }

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
