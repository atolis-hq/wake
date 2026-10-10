import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { claudeCommandArgs } from '../../../src/execution/infrastructure/runners/claude.js';
import { codexCommandArgs } from '../../../src/execution/infrastructure/runners/codex.js';

const request = {
  runId: 'run-1',
  prompt: 'work',
  allowedTools: [],
  mcpServers: [
    {
      name: 'wake',
      command: 'wake',
      args: ['artifact-mcp', '--session', 'session-1'],
      env: { WAKE_ARTIFACT_TOKEN: 'secret' },
    },
  ],
} as const;

describe('runner MCP configuration', () => {
  it('injects Claude MCP configuration and refuses ambient config', () => {
    const args = claudeCommandArgs(request);
    const index = args.indexOf('--mcp-config');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[index + 1] ?? '')).toEqual({
      mcpServers: {
        wake: {
          command: 'wake',
          args: ['artifact-mcp', '--session', 'session-1'],
          env: { WAKE_ARTIFACT_TOKEN: 'secret' },
        },
      },
    });
    expect(args).toContain('--strict-mcp-config');
  });

  it('injects Codex MCP configuration through one-run config overrides', () => {
    const args = codexCommandArgs(request);
    const override = args.find((arg) => arg.startsWith('mcp_servers.'));
    expect(override).toBeDefined();
    expect(parse(override!)).toEqual({
      mcp_servers: {
        wake: {
          command: request.mcpServers[0].command,
          args: [...request.mcpServers[0].args],
          env: request.mcpServers[0].env,
        },
      },
    });
  });
});
