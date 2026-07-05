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

export function buildStagePrompt(input: {
  action: AgentAction;
  projection: IssueStateRecord;
  recentEvents: EventEnvelope[];
}): string {
  const projectionSummary = {
    workItemKey: input.projection.workItemKey,
    repo: input.projection.issue.repo,
    issueNumber: input.projection.issue.number,
    stage: input.projection.wake.stage,
    attempts: input.projection.wake.attempts,
    title: input.projection.issue.title,
    latestComment: input.projection.latestComment?.body,
  };

  const sections = [
    'You are Eddy, the Wake execution identity.',
    `Stage: ${input.action}`,
    'Respond concisely.',
    'The last line of your response must be exactly one of: DONE, BLOCKED, FAILED.',
    'Projection summary:',
    JSON.stringify(projectionSummary, null, 2),
    'Recent events:',
    JSON.stringify(
      input.recentEvents.map((event) => ({
        eventId: event.eventId,
        sourceEventType: event.sourceEventType,
        occurredAt: event.occurredAt,
        payload: event.payload,
      })),
      null,
      2,
    ),
    'Issue body:',
    input.projection.issue.body,
  ];

  if (input.action === 'implement') {
    const branch = branchNameForIssue(input.projection.issue.number);
    sections.push(
      [
        'Completion requirements for this implement stage:',
        `- Your current working directory is a git checkout of ${input.projection.issue.repo}, already on branch ${branch}, created from the latest main.`,
        '- Make the code changes needed to resolve the issue directly in this working directory.',
        '- Stage and commit all changes with `git add -A` and a clear, descriptive commit message.',
        `- Push the branch with \`git push -u origin ${branch}\`.`,
        `- Open a pull request against main with \`gh pr create --base main --head ${branch} --title "<summary>" --body "Closes #${input.projection.issue.number}"\`.`,
        '- Do not merge the pull request yourself; a human reviews and merges it.',
        '- Include the pull request URL in your response before the final sentinel line.',
        '- If you cannot safely complete the change, leave the workspace as-is and end with BLOCKED or FAILED instead of guessing.',
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

export function buildClaudePrintArgs(options: {
  model: string;
  prompt: string;
  sessionName: string;
  permissionMode?: string;
  allowedTools?: string[];
  remoteControlName?: string;
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
    // Terminate option parsing so the prompt is never swallowed by a
    // variadic/optional-value flag above (e.g. --allowedTools, --remote-control).
    '--',
    options.prompt,
  ];
}

const implementAllowedTools = [
  'Bash(git *)',
  'Bash(gh *)',
  'Bash(npm *)',
  'Edit',
  'Write',
  'Read',
  'Glob',
  'Grep',
];

const refineAllowedTools = ['Read', 'Glob', 'Grep'];

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

      const args = buildClaudePrintArgs({
        model: input.config.runner.claude.model,
        prompt: buildStagePrompt({
          action: input.action,
          projection: input.projection,
          recentEvents: input.recentEvents,
        }),
        sessionName,
        permissionMode: input.action === 'implement' ? 'acceptEdits' : 'default',
        allowedTools:
          input.action === 'implement' ? implementAllowedTools : refineAllowedTools,
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
