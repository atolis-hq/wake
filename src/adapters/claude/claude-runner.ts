import { spawn } from 'node:child_process';

import type { AgentRunResult, AgentRunTokenUsage } from '../../core/contracts.js';
import { parseClaudePrintResult } from '../../domain/schema.js';
import type {
  AgentAction,
  ClaudePrintResult,
  EventEnvelope,
  IssueStateRecord,
  WakeConfig,
} from '../../domain/types.js';
import { branchNameForIssue } from '../git/git-workspace-manager.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompt-templates.js';

function slugify(value: string, maxLength = 40): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

export function buildEddySessionName(input: {
  sessionName: string;
  issueNumber: number;
  title: string;
  runId: string;
}): string {
  return [
    input.sessionName,
    `issue-${input.issueNumber}`,
    slugify(input.title),
    input.runId,
  ]
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
  workspacePath?: string;
  sessionId?: string;
  exitCode?: number;
}): string {
  const parts = [
    '[claude-run]',
    `phase=${input.phase}`,
    `runId=${input.runId}`,
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

type CommentSnapshot = IssueStateRecord['comments'][number];

function formatComment(comment: CommentSnapshot): string {
  return `- ${comment.author.login} (${comment.createdAt}): ${comment.body}`;
}

function formatCommentList(comments: CommentSnapshot[]): string {
  return comments.length > 0 ? comments.map(formatComment).join('\n') : '(none)';
}

// Comments Wake itself posted (status updates) or that a bot authored are
// noise for "what changed since I last looked" - only human replies should
// prompt the resumed agent to reconsider its approach.
function newCommentsSinceLastRun(projection: IssueStateRecord): CommentSnapshot[] {
  const handledCommentId = projection.context.lastHandledCommentId;
  const cursorIndex =
    typeof handledCommentId === 'string'
      ? projection.comments.findIndex((comment) => comment.id === handledCommentId)
      : -1;
  const candidates =
    cursorIndex === -1 ? projection.comments : projection.comments.slice(cursorIndex + 1);

  return candidates.filter((comment) => !comment.isWakeAuthored && !comment.isBotAuthored);
}

function parseFrontmatterList(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseFrontmatterArgs(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  return value.trim().split(/\s+/);
}

function parseFrontmatterMaxTurns(input: { action: AgentAction; value: string | undefined }): number {
  if (input.value === undefined || input.value.trim().length === 0) {
    throw new Error(
      `Prompt template for action "${input.action}" is missing a required "maxTurns" frontmatter value. ` +
        'Every runner invocation must carry a --max-turns cap; add one to the template.',
    );
  }

  const parsed = Number(input.value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Prompt template for action "${input.action}" has an invalid "maxTurns" frontmatter value: ${input.value}`,
    );
  }

  return parsed;
}

export interface StagePromptResult {
  prompt: string;
  permissionMode?: string;
  allowedTools: string[];
  extraArgs: string[];
  maxTurns: number;
}

export async function buildStagePrompt(input: {
  action: AgentAction;
  projection: IssueStateRecord;
  mode?: 'start' | 'resume';
  config?: WakeConfig;
}): Promise<StagePromptResult> {
  const mode = input.mode ?? 'start';
  const template = await loadPromptTemplate(input.action, mode, {
    ...(input.config?.paths.promptsRoot === undefined
      ? {}
      : { promptsRoot: input.config.paths.promptsRoot }),
  });

  const context: Record<string, unknown> = {
    workItemKey: input.projection.workItemKey,
    repo: input.projection.issue.repo,
    issueNumber: input.projection.issue.number,
    title: input.projection.issue.title,
    stage: input.projection.wake.stage,
    attempts: input.projection.wake.attempts,
    body: input.projection.issue.body,
    allCommentsText: formatCommentList(input.projection.comments),
    newCommentsText: formatCommentList(newCommentsSinceLastRun(input.projection)),
  };

  if (input.action === 'implement') {
    context.branch = branchNameForIssue(input.projection.issue.number);
  }

  const allowedTools = parseFrontmatterList(template.frontmatter.allowedTools);
  // Single source of truth: the prompt's tool-restriction prose references
  // this instead of separately restating the tool list, so the two can't
  // drift out of sync.
  context.allowedToolsList = allowedTools.length > 0 ? allowedTools.join(', ') : '(none)';

  const permissionMode = template.frontmatter.permissionMode;

  return {
    prompt: renderPromptTemplate(template, context),
    allowedTools,
    extraArgs: parseFrontmatterArgs(template.frontmatter.extraArgs),
    maxTurns: parseFrontmatterMaxTurns({ action: input.action, value: template.frontmatter.maxTurns }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}

export function buildClaudePrintArgs(options: {
  model: string;
  prompt: string;
  sessionName: string;
  permissionMode?: string;
  allowedTools?: string[];
  remoteControlName?: string;
  extraArgs?: string[];
  maxTurns?: number;
}): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    options.model,
    '--name',
    options.sessionName,
    ...(options.maxTurns === undefined ? [] : ['--max-turns', String(options.maxTurns)]),
    ...(options.permissionMode === undefined
      ? []
      : ['--permission-mode', options.permissionMode]),
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

const TIMEOUT_KILL_GRACE_MS = 5_000;

export function runClaudeCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    // Runaway-cost protection: a hung/looping CLI invocation must never be
    // able to hold the tick lock forever - kill it and surface as FAILED.
    const timeoutTimer =
      input.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_KILL_GRACE_MS);
          }, input.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        timedOut,
      });
    });
  });
}

function parseClaudePrintOutput(stdout: string): ClaudePrintResult {
  return parseClaudePrintResult(JSON.parse(stdout));
}

function extractTokenUsage(usage: ClaudePrintResult['usage']): AgentRunTokenUsage | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  return { inputTokens, outputTokens };
}

const CLAUDE_CLI_NAME = 'Claude';

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

export function createClaudeRunner(options: {
  command: string;
  cwd: string;
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
      const sessionName = buildEddySessionName({
        sessionName: input.config.runner.claude.sessionName,
        issueNumber: input.projection.issue.number,
        title: input.projection.issue.title,
        runId: input.runId,
      });

      // Wake always starts a fresh session today - it does not yet call
      // `claude --resume`, so mode is always 'start'. The 'resume' templates
      // exist for when that policy (tracked in todo/) is wired up.
      const stagePrompt = await buildStagePrompt({
        action: input.action,
        projection: input.projection,
        mode: 'start',
        config: input.config,
      });

      const args = buildClaudePrintArgs({
        model: input.config.runner.claude.model,
        prompt: stagePrompt.prompt,
        sessionName,
        allowedTools: stagePrompt.allowedTools,
        extraArgs: stagePrompt.extraArgs,
        maxTurns: stagePrompt.maxTurns,
        ...(stagePrompt.permissionMode === undefined
          ? {}
          : { permissionMode: stagePrompt.permissionMode }),
        ...(input.config.runner.claude.remoteControl.enabled
          ? { remoteControlName: sessionName }
          : {}),
      });

      console.log(
        formatClaudeRunLogLine({
          phase: 'start',
          runId: input.runId,
          action: input.action,
          issueNumber: input.projection.issue.number,
          repo: input.projection.issue.repo,
          recentEventIds: input.recentEvents.map((event) => event.eventId),
          ...(input.workspacePath === undefined
            ? {}
            : { workspacePath: input.workspacePath }),
        }),
      );

      const result = await runClaudeCommand({
        command: options.command,
        args,
        cwd: input.workspacePath ?? options.cwd,
        timeoutMs: input.config.runner.claude.timeoutMs,
      });

      if (result.exitCode !== 0 || result.timedOut) {
        const sandboxLog = readSandboxLogBreadcrumb();
        console.error(
          formatClaudeRunLogLine({
            phase: 'failure',
            runId: input.runId,
            action: input.action,
            issueNumber: input.projection.issue.number,
            repo: input.projection.issue.repo,
            recentEventIds: input.recentEvents.map((event) => event.eventId),
            ...(input.workspacePath === undefined
              ? {}
              : { workspacePath: input.workspacePath }),
            exitCode: result.exitCode,
          }),
        );
        return {
          result: [
            result.timedOut
              ? `Claude runner timed out after ${input.config.runner.claude.timeoutMs}ms and was killed`
              : 'Claude runner failed',
            result.stderr,
            sandboxLog?.text,
            'FAILED',
          ]
            .filter((part) => part !== undefined && part.length > 0)
            .join('\n'),
          model: input.config.runner.claude.model,
          cli: CLAUDE_CLI_NAME,
          metadata: {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            ...(sandboxLog?.metadata ?? {}),
          },
        };
      }

      const parsed = parseClaudePrintOutput(result.stdout);
      const sandboxLog = readSandboxLogBreadcrumb();
      console.log(
        formatClaudeRunLogLine({
          phase: 'success',
          runId: input.runId,
          action: input.action,
          issueNumber: input.projection.issue.number,
          repo: input.projection.issue.repo,
          recentEventIds: input.recentEvents.map((event) => event.eventId),
          ...(input.workspacePath === undefined
            ? {}
            : { workspacePath: input.workspacePath }),
          ...(parsed.session_id === undefined ? {} : { sessionId: parsed.session_id }),
        }),
      );
      const tokenUsage = extractTokenUsage(parsed.usage);
      return {
        result: parsed.result,
        model: input.config.runner.claude.model,
        cli: CLAUDE_CLI_NAME,
        ...(parsed.session_id === undefined
          ? {}
          : { session_id: parsed.session_id }),
        ...(tokenUsage === undefined ? {} : { tokenUsage }),
        metadata: {
          stdout: result.stdout,
          stderr: result.stderr,
          raw: parsed,
          ...(sandboxLog?.metadata ?? {}),
        },
      };
    },
    async smoke(config: WakeConfig): Promise<{
      text: string;
      sessionId?: string;
      stdout: string;
      stderr: string;
      exitCode: number;
    }> {
      const args = buildClaudePrintArgs({
        model: config.runner.claude.smokeModel,
        prompt: config.runner.claude.smokePrompt,
        sessionName: config.runner.claude.sessionName,
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
        ...(parsed?.session_id === undefined
          ? {}
          : { sessionId: parsed.session_id }),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
    async startRemoteControlSmoke(config: WakeConfig): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      command: string;
      args: string[];
    }> {
      const args = buildClaudeRemoteControlArgs({
        model: config.runner.claude.smokeModel,
        prompt: config.runner.claude.smokePrompt,
        remoteControlName: config.runner.claude.remoteControlName,
        sessionName: config.runner.claude.sessionName,
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
