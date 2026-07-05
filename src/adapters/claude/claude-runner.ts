import { spawn } from 'node:child_process';

import type { AgentRunResult } from '../../core/contracts.js';
import { parseClaudePrintResult } from '../../domain/schema.js';
import type {
  AgentAction,
  ClaudePrintResult,
  IssueStateRecord,
  WakeConfig,
} from '../../domain/types.js';

function buildStagePrompt(input: {
  action: AgentAction;
  issue: IssueStateRecord;
}): string {
  return [
    'You are Eddy, the Wake execution identity.',
    `Stage: ${input.action}`,
    'Respond concisely.',
    'The last line of your response must be exactly one of: DONE, BLOCKED, FAILED.',
    `Issue: ${input.issue.issue.title}`,
    input.issue.issue.body,
  ].join('\n\n');
}

export function buildClaudePrintArgs(options: {
  model: string;
  prompt: string;
  sessionName: string;
}): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    options.model,
    '--name',
    options.sessionName,
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
      issue: IssueStateRecord;
      config: WakeConfig;
    }): Promise<AgentRunResult> {
      const args = buildClaudePrintArgs({
        model: input.config.runner.claude.model,
        prompt: buildStagePrompt({
          action: input.action,
          issue: input.issue,
        }),
        sessionName: input.config.runner.claude.sessionName,
      });

      const result = await runClaudeCommand({
        command: options.command,
        args,
        cwd: options.cwd,
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
