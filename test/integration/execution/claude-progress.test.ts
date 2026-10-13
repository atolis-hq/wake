import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRunnerRegistry } from '../../../src/bootstrap/runner-registry.js';
import { RunStatus } from '../../../src/execution/index.js';
import { parseAgentRunnerResponse } from '../../../src/execution/infrastructure/agent-runner-adapter.js';

function runner(hardMs = 5000) {
  return createRunnerRegistry({
    defaultRunnerPool: 'standard',
    runnerPools: { standard: ['configured-claude'] },
    agentRunners: {
      'configured-claude': {
        kind: 'claude-cli',
        args: [],
        model: 'configured-model',
        command: fileURLToPath(new URL('./fixtures/claude-progress.cjs', import.meta.url)),
        runnerTimeouts: { idleMs: 400, hardMs, cancellationGraceMs: 5 },
      },
    },
  }).resolve('standard').runner;
}

const request = (prompt: string) => ({
  runId: 'progress-run',
  prompt,
  allowedTools: ['Read'],
  resumeSessionId: 'prior-session',
  mcpServers: [{ name: 'wake', command: 'wake-mcp' }],
});

describe.sequential('production Claude progress supervision', () => {
  it('completes beyond the idle window and capture budget using real progress and final decoding', async () => {
    const configured = runner();
    expect(configured.supportsSessionResume).toBe(true);
    expect(configured.supportsEphemeralMcp).toBe(true);
    const execution = await configured.start(request('progress'), new AbortController().signal);
    const result = await execution.result;
    expect(result).toMatchObject({
      transport: RunStatus.Succeeded,
      model: 'configured-model',
      sessionId: 'resumed-session',
      output: 'Finished café. [[STATUS: DONE]]',
      tokenUsage: { input: 12, output: 7, cacheRead: 3, costUsd: 0.02 },
    });
    expect(parseAgentRunnerResponse(result)).toMatchObject({
      outcome: 'DONE',
      displayBody: 'Finished café.',
    });
  });

  it('preserves plain stdout quota diagnostics on failure', async () => {
    const execution = await runner().start(request('plain-error'), new AbortController().signal);
    await expect(execution.result).resolves.toMatchObject({
      transport: RunStatus.Failed,
      failure: { kind: 'provider-quota-exceeded', message: 'Provider rate limit exceeded' },
    });
  });

  it('completes after an oversized tool-input progress record', async () => {
    const execution = await runner().start(request('oversized'), new AbortController().signal);
    await expect(execution.result).resolves.toMatchObject({
      transport: RunStatus.Succeeded,
      sessionId: 'resumed-session',
      output: 'Finished café. [[STATUS: DONE]]',
    });
  });

  it('decodes buffered final-only JSON without a newline', async () => {
    const execution = await runner().start(request('buffered'), new AbortController().signal);
    await expect(execution.result).resolves.toMatchObject({
      transport: RunStatus.Succeeded,
      sessionId: 'resumed-session',
      output: 'Finished café. [[STATUS: DONE]]',
    });
  });

  it.each(['silent', 'noise'])(
    'times out %s instead of treating unrelated records as progress',
    async (mode) => {
      const execution = await runner().start(request(mode), new AbortController().signal);
      await expect(execution.result).resolves.toMatchObject({
        transport: RunStatus.Failed,
        failure: { kind: 'idle-timeout' },
      });
    },
  );

  it('enforces the hard deadline despite continuous progress', async () => {
    const execution = await runner(650).start(request('endless'), new AbortController().signal);
    await expect(execution.result).resolves.toMatchObject({
      transport: RunStatus.Failed,
      failure: { kind: 'timeout' },
    });
  });

  it('honours explicit cancellation despite continuous progress', async () => {
    const controller = new AbortController();
    const timeouts: string[] = [];
    const execution = await runner().start(
      {
        ...request('endless'),
        onTimeout: async (kind) => {
          timeouts.push(kind);
        },
      },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    controller.abort();
    await expect(execution.result).resolves.toMatchObject({
      transport: RunStatus.Failed,
      failure: { kind: 'process-exit' },
    });
    expect(timeouts).toEqual([]);
  });
});
