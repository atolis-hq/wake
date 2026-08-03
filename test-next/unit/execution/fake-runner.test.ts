import { expect, it } from 'vitest';
import {
  FakeExecutionRunner,
  RunStatus,
  parseFakeScenarios,
} from '../../../src-next/execution/index.js';
import { parseAgentRunnerResponse } from '../../../src-next/execution/infrastructure/agent-runner-adapter.js';

it('parses a legacy wake-result envelope into a typed response without retaining protocol output', () => {
  expect(parseAgentRunnerResponse({ transport: RunStatus.Succeeded, output: 'Implemented the change.\n\n```wake-result\n{"status":"DONE"}\n```\n', runner: 'codex', model: 'gpt-5', sessionId: 'session-1', tokenUsage: { input: 10, output: 20, costUsd: 0.03 } })).toEqual({ outcome: 'DONE', displayBody: 'Implemented the change.', metadata: { runner: 'codex', model: 'gpt-5', sessionId: 'session-1', inputTokens: 10, outputTokens: 20, costUsd: 0.03 } });
});

it('completes a fake execution with the deterministic DONE sentinel', async () => {
  const execution = await new FakeExecutionRunner().start({ runId: 'run-1', prompt: 'complete', allowedTools: [] }, new AbortController().signal);
  await expect(execution.result).resolves.toEqual({ transport: RunStatus.Succeeded, output: JSON.stringify({ status: 'DONE' }), runner: 'fake' });
});

it('uses a configured scenario outcome and body', async () => {
  const scenarios = parseFakeScenarios({
    schemaVersion: 1,
    rules: [
      {
        name: 'fails-first',
        when: { runner: 'fake-worker', action: 'refine', occurrence: 1 },
        afterMs: 1,
        outcome: 'FAILED',
        retrySafety: 'safe-to-retry',
        displayBody: 'Fake worker failed safely.',
      },
    ],
  });
  const execution = await new FakeExecutionRunner('fake-worker', scenarios).start(
    {
      runId: 'run-1',
      prompt: 'complete',
      allowedTools: [],
      context: {
        runnerName: 'fake-worker',
        action: 'refine',
        activationOrdinal: 1,
      },
    },
    new AbortController().signal,
  );

  await expect(execution.result).resolves.toEqual({
    transport: RunStatus.Succeeded,
    output: JSON.stringify({
      status: 'FAILED',
      retrySafety: 'safe-to-retry',
      displayBody: 'Fake worker failed safely.',
    }),
    runner: 'fake-worker',
  });
});

it('rejects a delayed fake execution when its signal aborts', async () => {
  const scenarios = parseFakeScenarios({
    schemaVersion: 1,
    rules: [
      {
        name: 'slow',
        when: { runner: 'fake-worker', action: 'implement' },
        afterMs: 10_000,
        outcome: 'DONE',
      },
    ],
  });
  const controller = new AbortController();
  const execution = await new FakeExecutionRunner('fake-worker', scenarios).start(
    {
      runId: 'run-1',
      prompt: 'complete',
      allowedTools: [],
      context: { runnerName: 'fake-worker', action: 'implement', activationOrdinal: 1 },
    },
    controller.signal,
  );
  controller.abort();

  await expect(execution.result).rejects.toThrow(/aborted/i);
});

it('parses a structured runner result without exposing its machine envelope', () => {
  const response = parseAgentRunnerResponse({ transport: RunStatus.Succeeded, output: '{"status":"REJECTED"}', runner: 'codex' });
  expect(response).toMatchObject({ outcome: 'REJECTED' });
  expect(response.displayBody).toContain('Run rejected');
  expect(response.displayBody).not.toContain('status');
});
