import { expect, it } from 'vitest';
import { projectTerminalAgentRunReport } from '../../src-next/integrations/index.js';

it('projects a terminal agent run without requiring agent fields on non-agent facts', () => {
  expect(
    projectTerminalAgentRunReport({
      run: {
        runId: 'run-1',
        startedAt: '2026-08-03T12:00:00.000Z',
        finishedAt: '2026-08-03T12:00:03.000Z',
        failure: { message: 'runner unavailable' },
      },
      stage: 'implement',
    }),
  ).toEqual({
    runId: 'run-1',
    stage: 'implement',
    startedAt: '2026-08-03T12:00:00.000Z',
    finishedAt: '2026-08-03T12:00:03.000Z',
    displayBody: 'runner unavailable',
    outcome: 'FAILED',
    metadata: {},
  });
});
it('retains resolved runner, pool, CLI, and agent metadata in the generic report', () => {
  expect(
    projectTerminalAgentRunReport({
      run: {
        runId: 'run-2',
        startedAt: '2026-08-03T12:00:00.000Z',
        finishedAt: '2026-08-03T12:00:03.000Z',
        runner: { name: 'codex', pool: 'standard', cli: 'codex-cli', model: 'gpt-5' },
        agent: {
          outcome: 'DONE',
          displayBody: 'Completed.',
          metadata: { inputTokens: 11, outputTokens: 13, costUsd: 0.04, sessionId: 'session-2' },
        },
      },
      stage: 'implement',
    }),
  ).toMatchObject({
    runner: 'codex',
    runnerPool: 'standard',
    cli: 'codex-cli',
    model: 'gpt-5',
    sessionId: 'session-2',
    metadata: { inputTokens: 11, outputTokens: 13, costUsd: 0.04 },
  });
});
