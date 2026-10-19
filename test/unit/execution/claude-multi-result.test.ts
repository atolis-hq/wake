import { describe, expect, it } from 'vitest';
import { createClaudeStreamDecoder } from '../../../src/execution/infrastructure/runners/claude-stream.js';
import {
  classifyClaudeFailure,
  parseClaudeOutput,
} from '../../../src/execution/infrastructure/runners/claude.js';

const first = {
  type: 'result',
  result: "The install is running in the background; I'll continue when it finishes.",
  session_id: 'session-1',
  usage: { input_tokens: 1, output_tokens: 2 },
  total_cost_usd: 0.01,
};
const second = {
  type: 'result',
  result: 'Parallel stages on desktop now stack.',
  session_id: 'session-2',
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
  total_cost_usd: 0.5,
  origin: { kind: 'task-notification' },
};

function decodeStream(): string {
  const decoder = createClaudeStreamDecoder();
  const stream = [
    { type: 'assistant', message: {} },
    first,
    { type: 'assistant', message: {} },
    second,
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  const pushed = decoder.push(Buffer.from(stream + '\n'));
  return Buffer.concat([pushed.output, decoder.finish()]).toString('utf8');
}

describe('Claude multiple result events', () => {
  it('keeps decoded results newline-delimited, including an unterminated final line', () => {
    const decoder = createClaudeStreamDecoder();
    const pushed = decoder.push(Buffer.from(`${JSON.stringify(first)}\n${JSON.stringify(second)}`));
    const out = Buffer.concat([pushed.output, decoder.finish()]).toString('utf8');
    expect(out.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('uses the last result for output, session and usage (#983 shape)', () => {
    expect(parseClaudeOutput(decodeStream())).toEqual({
      output: second.result,
      sessionId: 'session-2',
      tokenUsage: { input: 10, output: 20, cacheRead: 5, costUsd: 0.5 },
    });
  });

  it('keeps the legacy single-object shape', () => {
    expect(parseClaudeOutput(JSON.stringify(first)).output).toBe(first.result);
  });

  it('yields no output when the last result is unusable', () => {
    const stdout = `${JSON.stringify(first)}\n${JSON.stringify({ type: 'result', result: 3 })}\n`;
    expect(parseClaudeOutput(stdout)).toEqual({});
  });

  it('classifies failures from the last result', () => {
    const stdout =
      `${JSON.stringify(first)}\n` +
      `${JSON.stringify({ type: 'result', is_error: true, result: 'Usage limit reached' })}\n`;
    expect(classifyClaudeFailure({ stdout, stderr: '' })?.kind).toBe('provider-quota-exceeded');
  });
});
