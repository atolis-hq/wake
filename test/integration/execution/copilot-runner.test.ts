import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyCopilotFailure,
  copilotCommandArgs,
  copilotMcpFailure,
  createCopilotRunner,
  parseCopilotOutput,
} from '../../../src/execution/index.js';

// Event shapes captured from Copilot CLI 1.0.95 `--output-format json`.
const event = (value: Record<string, unknown>) => JSON.stringify(value);
const successStdout = [
  event({ type: 'session.mcp_servers_loaded', data: { servers: [] }, ephemeral: true }),
  event({ type: 'user.message', data: { content: 'ship' } }),
  event({ type: 'assistant.message_delta', data: { deltaContent: 'interim' }, ephemeral: true }),
  event({
    type: 'assistant.message',
    data: { content: 'reading files', toolRequests: [{ name: 'view' }] },
  }),
  event({ type: 'assistant.message', data: { content: '', toolRequests: [{ name: 'bash' }] } }),
  event({ type: 'assistant.message', agentId: 'sub-1', data: { content: 'sub-agent answer' } }),
  event({ type: 'assistant.message', data: { content: 'final answer\n[[STATUS: DONE]]' } }),
  event({ type: 'assistant.turn_end', data: { turnId: '0' } }),
  event({
    type: 'result',
    sessionId: 'copilot-session',
    exitCode: 0,
    usage: { premiumRequests: 0 },
  }),
].join('\n');

const usageReport = (models: Record<string, Record<string, number>>) =>
  JSON.stringify({
    totalUserRequests: 1,
    modelMetrics: Object.fromEntries(
      Object.entries(models).map(([model, usage]) => [model, { requests: { count: 1 }, usage }]),
    ),
  });

describe('Copilot runner adapter', () => {
  const request = { runId: 'run-1', prompt: 'ship', allowedTools: [] };

  it('builds an unattended prompt-mode invocation with JSONL output', () => {
    expect(copilotCommandArgs(request)).toEqual([
      '--prompt=ship',
      '--output-format',
      'json',
      '--allow-all',
      '--no-ask-user',
      '--no-auto-update',
    ]);
  });

  it('keeps a prompt that starts with a dash bound to the prompt flag', () => {
    expect(copilotCommandArgs({ ...request, prompt: '--- heading' })[0]).toBe(
      '--prompt=--- heading',
    );
  });

  it('forwards model, effort, resume, usage file, and passthrough arguments', () => {
    expect(
      copilotCommandArgs(
        { ...request, model: 'gpt-5.4', effort: 'high', resumeSessionId: 'session-1' },
        ['--flag', 'copilot'],
        {},
        '/tmp/usage.json',
      ),
    ).toEqual(
      expect.arrayContaining([
        '--model',
        'gpt-5.4',
        '--reasoning-effort',
        'high',
        '--resume=session-1',
        '--usage-output-file',
        '/tmp/usage.json',
        '--flag',
        'copilot',
      ]),
    );
  });

  it('uses configured runner model and effort when the request does not override them', () => {
    expect(copilotCommandArgs(request, [], { model: 'auto', effort: 'medium' })).toEqual(
      expect.arrayContaining(['--model', 'auto', '--reasoning-effort', 'medium']),
    );
  });

  it('removes file-editing tools only for read-only workspaces', () => {
    expect(copilotCommandArgs({ ...request, workspaceMode: 'read-only' })).toContain(
      '--excluded-tools=edit,create',
    );
    expect(copilotCommandArgs({ ...request, workspaceMode: 'branch' })).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^--excluded-tools/u)]),
    );
  });

  it('injects trusted per-run MCP servers as one-run additional configuration', () => {
    const args = copilotCommandArgs({
      ...request,
      mcpServers: [{ name: 'wake', command: 'node', args: ['mcp.js'], env: { TOKEN: 't' } }],
    });
    const config = args[args.indexOf('--additional-mcp-config') + 1];

    expect(JSON.parse(config!)).toEqual({
      mcpServers: { wake: { command: 'node', args: ['mcp.js'], env: { TOKEN: 't' } } },
    });
  });

  it('uses the last main-agent message as output and the result session id', () => {
    expect(parseCopilotOutput(successStdout)).toEqual({
      output: 'final answer\n[[STATUS: DONE]]',
      sessionId: 'copilot-session',
    });
  });

  it('sums the usage report across models, excluding cached tokens from input', () => {
    // Real 1.0.117 shape: inputTokens (17177) = uncached (11545) + cacheRead (5632).
    const report = usageReport({
      'model-a': {
        inputTokens: 17177,
        outputTokens: 10,
        cacheReadTokens: 5632,
        cacheWriteTokens: 0,
      },
      'model-b': { inputTokens: 25, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 5 },
    });

    expect(parseCopilotOutput(successStdout, request, report).tokenUsage).toEqual({
      input: 11565,
      output: 13,
      cacheRead: 5632,
      cacheWrite: 5,
    });
  });

  it('omits token usage when cached tokens exceed the reported input', () => {
    const report = usageReport({
      model: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 20, cacheWriteTokens: 0 },
    });

    expect(parseCopilotOutput(successStdout, request, report)).not.toHaveProperty('tokenUsage');
  });

  it('subtracts the resumed-session baseline from the cumulative usage report', () => {
    const report = usageReport({
      model: { inputTokens: 360, outputTokens: 9, cacheReadTokens: 60, cacheWriteTokens: 0 },
    });
    const resumed = {
      ...request,
      usageBaseline: { input: 200, output: 6, cacheRead: 40, cacheWrite: 0 },
    };

    expect(parseCopilotOutput(successStdout, resumed, report).tokenUsage).toEqual({
      input: 100,
      output: 3,
      cacheRead: 20,
      cacheWrite: 0,
    });
  });

  it('omits token usage when the report is missing, malformed, or partial', () => {
    expect(parseCopilotOutput(successStdout, request, undefined)).not.toHaveProperty('tokenUsage');
    expect(parseCopilotOutput(successStdout, request, 'not json')).not.toHaveProperty('tokenUsage');
    expect(
      parseCopilotOutput(successStdout, request, usageReport({ model: { inputTokens: 1 } })),
    ).not.toHaveProperty('tokenUsage');
  });

  it('leaves stdout untouched when it carries no recognizable Copilot result', () => {
    expect(parseCopilotOutput('plain stdout')).toEqual({});
    expect(parseCopilotOutput('null\n[]')).toEqual({});
  });

  it.each(['rate_limit', 'quota'])(
    'classifies a %s session.error as provider-quota-exceeded',
    (errorType) => {
      const stdout = [
        event({ type: 'model.call_failure', data: { statusCode: 429 }, ephemeral: true }),
        event({
          type: 'session.error',
          data: {
            errorType,
            message: 'Failed to get response; 429 quota exceeded',
            statusCode: 429,
          },
        }),
        event({ type: 'result', sessionId: 's', exitCode: 1 }),
      ].join('\n');

      expect(classifyCopilotFailure({ stdout, stderr: '' })).toEqual({
        kind: 'provider-quota-exceeded',
        message: 'Failed to get response; 429 quota exceeded',
      });
    },
  );

  it('does not classify authentication errors or agent prose as quota-exceeded', () => {
    expect(
      classifyCopilotFailure({
        stdout: event({
          type: 'session.error',
          data: { errorType: 'authentication', message: 'Not authorized' },
        }),
        stderr: '',
      }),
    ).toBeUndefined();
    expect(
      classifyCopilotFailure({
        stdout: event({
          type: 'assistant.message',
          data: { content: 'I fixed the rate limit quota check' },
        }),
        stderr: 'Error: Access denied by policy settings',
      }),
    ).toBeUndefined();
  });
});

// Captured from Copilot CLI 1.0.95 on an account whose policy blocks
// third-party MCP servers: the CLI drops the server and still exits 0.
const blockedMcpStdout = [
  event({
    type: 'session.warning',
    data: {
      message:
        "Third-party MCP servers are disabled by your organization's Copilot policy. Only built-in servers are available.",
      warningType: 'policy',
    },
    ephemeral: true,
  }),
  event({
    type: 'session.warning',
    data: { message: "1 MCP server was blocked by policy: 'wake'", warningType: 'mcp' },
    ephemeral: true,
  }),
  event({
    type: 'session.mcp_servers_loaded',
    data: { servers: [{ name: 'github-mcp-server', status: 'connected', source: 'builtin' }] },
    ephemeral: true,
  }),
  successStdout,
].join('\n');
const wakeMcpRequest = {
  runId: 'run-1',
  prompt: 'ship',
  allowedTools: [],
  mcpServers: [{ name: 'wake', command: 'node', args: ['mcp.js'] }],
};

describe('Copilot MCP availability', () => {
  it('reports a requested MCP server that Copilot did not connect', () => {
    expect(copilotMcpFailure(blockedMcpStdout, wakeMcpRequest)).toEqual({
      kind: 'runner-mcp-unavailable',
      message: expect.stringMatching(
        /^Copilot did not connect MCP server\(s\): wake\n.*blocked by policy: 'wake'/su,
      ),
    });
  });

  it('accepts a run whose requested MCP servers are connected', () => {
    const stdout = [
      event({
        type: 'session.mcp_servers_loaded',
        data: { servers: [{ name: 'wake', status: 'connected' }] },
      }),
      successStdout,
    ].join('\n');

    expect(copilotMcpFailure(stdout, wakeMcpRequest)).toBeUndefined();
  });

  it('reports a requested MCP server that loaded without connecting', () => {
    const stdout = event({
      type: 'session.mcp_servers_loaded',
      data: { servers: [{ name: 'wake', status: 'failed' }] },
    });

    expect(copilotMcpFailure(stdout, wakeMcpRequest)?.kind).toBe('runner-mcp-unavailable');
  });

  it('does not fail without evidence or when no MCP server was requested', () => {
    const withoutReport = successStdout
      .split('\n')
      .filter((line) => !line.includes('session.mcp_servers_loaded'))
      .join('\n');

    expect(copilotMcpFailure(withoutReport, wakeMcpRequest)).toBeUndefined();
    expect(
      copilotMcpFailure(blockedMcpStdout, { runId: 'run-1', prompt: 'ship', allowedTools: [] }),
    ).toBeUndefined();
  });
});

describe('Copilot runner process', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it('reads token usage from its own usage file and removes the file afterwards', async () => {
    directory = await mkdtemp(join(tmpdir(), 'wake-copilot-test-'));
    const command = join(directory, 'copilot');
    const report = usageReport({
      model: { inputTokens: 28, outputTokens: 13, cacheReadTokens: 17, cacheWriteTokens: 0 },
    });
    await writeFile(
      command,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const file = process.argv[process.argv.indexOf('--usage-output-file') + 1];",
        `fs.writeFileSync(file, ${JSON.stringify(report)});`,
        `process.stdout.write(${JSON.stringify(successStdout)});`,
      ].join('\n'),
    );
    await chmod(command, 0o755);
    const before = await usageFiles();

    const execution = await createCopilotRunner({ command }).start(
      { runId: 'run-1', prompt: 'ship', allowedTools: [] },
      new AbortController().signal,
    );

    await expect(execution.result).resolves.toMatchObject({
      transport: 'succeeded',
      runner: 'copilot',
      output: 'final answer\n[[STATUS: DONE]]',
      sessionId: 'copilot-session',
      tokenUsage: { input: 11, output: 13, cacheRead: 17, cacheWrite: 0 },
    });
    expect(await usageFiles()).toEqual(before);
  });

  it('fails a successful exit that dropped a requested MCP server', async () => {
    directory = await mkdtemp(join(tmpdir(), 'wake-copilot-test-'));
    const command = join(directory, 'copilot');
    await writeFile(
      command,
      ['#!/usr/bin/env node', `process.stdout.write(${JSON.stringify(blockedMcpStdout)});`].join(
        '\n',
      ),
    );
    await chmod(command, 0o755);

    const execution = await createCopilotRunner({ command }).start(
      wakeMcpRequest,
      new AbortController().signal,
    );

    await expect(execution.result).resolves.toMatchObject({
      transport: 'failed',
      runner: 'copilot',
      output: blockedMcpStdout,
      failure: { kind: 'runner-mcp-unavailable' },
    });
  });

  it('declares resume and ephemeral MCP support for runner-pool selection', () => {
    const runner = createCopilotRunner();

    expect(runner.supportsSessionResume).toBe(true);
    expect(runner.supportsEphemeralMcp).toBe(true);
  });
});

async function usageFiles(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('wake-copilot-usage-'));
}
