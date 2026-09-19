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
    expect(codexCommandArgs(request)).toContain(
      'mcp_servers.wake={command="wake",args=["artifact-mcp","--session","session-1"],env={"WAKE_ARTIFACT_TOKEN":"secret"}}',
    );
  });
});
