import { spawn } from 'node:child_process';

import type { AgentRunResult } from '../../core/contracts.js';
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

export interface StagePromptResult {
  prompt: string;
  permissionMode?: string;
  allowedTools: string[];
  extraArgs: string[];
}

export async function buildStagePrompt(input: {
  action: AgentAction;
  projection: IssueStateRecord;
  recentEvents: EventEnvelope[];
  mode?: 'start' | 'resume';
}): Promise<StagePromptResult> {
  const mode = input.mode ?? 'start';
  const template = await loadPromptTemplate(input.action, mode);

  const context: Record<string, unknown> = {
    workItemKey: input.projection.workItemKey,
    repo: input.projection.issue.repo,
    issueNumber: input.projection.issue.number,
    title: input.projection.issue.title,
    stage: input.projection.wake.stage,
    attempts: input.projection.wake.attempts,
    latestComment: input.projection.latestComment?.body ?? '(none)',
    body: input.projection.issue.body,
    recentEventsJson: input.recentEvents.map((event) => ({
      eventId: event.eventId,
      sourceEventType: event.sourceEventType,
      occurredAt: event.occurredAt,
      payload: event.payload,
    })),
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
}): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    options.model,
    '--name',
    options.sessionName,
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

function runClaudeCommand(input: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
      });
    });
  });
}

function parseClaudePrintOutput(stdout: string): ClaudePrintResult {
  return parseClaudePrintResult(JSON.parse(stdout));
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
        recentEvents: input.recentEvents,
        mode: 'start',
      });

      const args = buildClaudePrintArgs({
        model: input.config.runner.claude.model,
        prompt: stagePrompt.prompt,
        sessionName,
        allowedTools: stagePrompt.allowedTools,
        extraArgs: stagePrompt.extraArgs,
        ...(stagePrompt.permissionMode === undefined
          ? {}
          : { permissionMode: stagePrompt.permissionMode }),
        ...(input.config.runner.claude.remoteControl.enabled
          ? { remoteControlName: sessionName }
          : {}),
      });

      const result = await runClaudeCommand({
        command: options.command,
        args,
        cwd: input.workspacePath ?? options.cwd,
      });

      if (result.exitCode !== 0) {
        return {
          result: `Claude runner failed\n${result.stderr}\nFAILED`,
          model: input.config.runner.claude.model,
          metadata: {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          },
        };
      }

      const parsed = parseClaudePrintOutput(result.stdout);
      return {
        result: parsed.result,
        model: input.config.runner.claude.model,
        ...(parsed.session_id === undefined
          ? {}
          : { session_id: parsed.session_id }),
        metadata: {
          stdout: result.stdout,
          stderr: result.stderr,
          raw: parsed,
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
