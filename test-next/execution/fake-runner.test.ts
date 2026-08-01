import { expect, it } from 'vitest';
import { FakeExecutionRunner, RunStatus } from '../../src-next/execution/index.js';

it('completes a fake execution with the deterministic DONE sentinel', async () => {
  const execution = await new FakeExecutionRunner().start(
    { runId: 'run-1', prompt: 'complete', allowedTools: [] },
    new AbortController().signal,
  );

  await expect(execution.result).resolves.toEqual({
    transport: RunStatus.Succeeded,
    output: JSON.stringify({ status: 'DONE' }),
    runner: 'fake',
  });
});
