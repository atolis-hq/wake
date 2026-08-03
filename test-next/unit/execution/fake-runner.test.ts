import { expect, it } from 'vitest';
import { FakeExecutionRunner, RunStatus } from '../../../src-next/execution/index.js';
import { parseAgentRunnerResponse } from '../../../src-next/execution/infrastructure/agent-runner-adapter.js';

it('parses a legacy wake-result envelope into a typed response without retaining protocol output', () => {
  expect(parseAgentRunnerResponse({ transport: RunStatus.Succeeded, output: 'Implemented the change.\n\n```wake-result\n{"status":"DONE"}\n```\n', runner: 'codex', model: 'gpt-5', sessionId: 'session-1', tokenUsage: { input: 10, output: 20, costUsd: 0.03 } })).toEqual({ outcome: 'DONE', displayBody: 'Implemented the change.', metadata: { runner: 'codex', model: 'gpt-5', sessionId: 'session-1', inputTokens: 10, outputTokens: 20, costUsd: 0.03 } });
});

it('completes a fake execution with the deterministic DONE sentinel', async () => {
  const execution = await new FakeExecutionRunner().start({ runId: 'run-1', prompt: 'complete', allowedTools: [] }, new AbortController().signal);
  await expect(execution.result).resolves.toEqual({ transport: RunStatus.Succeeded, output: JSON.stringify({ status: 'DONE' }), runner: 'fake' });
});

it('parses a structured runner result without exposing its machine envelope', () => {
  const response = parseAgentRunnerResponse({ transport: RunStatus.Succeeded, output: '{"status":"REJECTED"}', runner: 'codex' });
  expect(response).toMatchObject({ outcome: 'REJECTED' });
  expect(response.displayBody).toContain('Run rejected');
  expect(response.displayBody).not.toContain('status');
});