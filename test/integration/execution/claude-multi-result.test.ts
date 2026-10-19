import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createClaudeRunner, RunStatus } from '../../../src/execution/index.js';

const fixture = fileURLToPath(new URL('./fixtures/claude-multi-result.cjs', import.meta.url));

beforeAll(() => chmodSync(fixture, 0o755));

async function run(prompt: string) {
  const runner = createClaudeRunner({ command: fixture });
  return (
    await runner.start({ runId: prompt, prompt, allowedTools: [] }, new AbortController().signal)
  ).result;
}

describe('Claude runner with multiple result events', () => {
  it('publishes the last result with its session and usage', async () => {
    const result = await run('two-results');
    expect(result).toMatchObject({
      transport: RunStatus.Succeeded,
      output: 'Parallel stages on desktop now stack. [[STATUS: DONE]]',
      sessionId: 'session-2',
      tokenUsage: { input: 10, output: 20, costUsd: 0.5 },
    });
  });

  it.each(['no-result', 'bad-final'])(
    'fails instead of publishing the raw envelope (%s)',
    async (mode) => {
      const result = await run(mode);
      expect(result).toMatchObject({
        transport: RunStatus.Failed,
        failure: { kind: 'claude-no-final-result' },
      });
      expect(JSON.stringify(result)).not.toContain('"type":"result"');
    },
  );
});
