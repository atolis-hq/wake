import { describe, expect, it } from 'vitest';
import { createClaudeStreamDecoder } from '../../../src/execution/infrastructure/runners/claude-stream.js';

describe('Claude stream framing', () => {
  it('handles split records, coalesced records and split UTF-8 without retaining progress', () => {
    const decoder = createClaudeStreamDecoder();
    const stream = Buffer.from(
      [
        JSON.stringify({ type: 'assistant', message: { content: 'working' } }),
        JSON.stringify({ type: 'user', message: { content: 'tool result' } }),
        JSON.stringify({ type: 'result', result: 'café', session_id: 'session' }),
      ].join('\n') + '\n',
    );
    const split = stream.indexOf(Buffer.from('é')) + 1;
    expect(decoder.push(stream.subarray(0, split))).toEqual({
      output: Buffer.alloc(0),
      activity: true,
    });
    const result = decoder.push(stream.subarray(split));
    expect(JSON.parse(result.output.toString())).toEqual({
      type: 'result',
      result: 'café',
      session_id: 'session',
    });
    expect(result.activity).toBe(true);
    expect(decoder.finish()).toEqual(Buffer.alloc(0));
  });

  it('does not treat malformed, unknown or initialization records as activity', () => {
    const decoder = createClaudeStreamDecoder();
    expect(
      decoder.push(Buffer.from('garbage\nnull\n[]\n{"type":"system"}\n{"type":"heartbeat"}\n')),
    ).toEqual({ output: Buffer.alloc(0), activity: false });
  });

  it('bounds incomplete and complete individual records before parsing', () => {
    const decoder = createClaudeStreamDecoder();
    decoder.push(Buffer.alloc(1024 * 1024, 120));
    expect(() => decoder.push(Buffer.from('x'))).toThrow('output limit');
    expect(() => createClaudeStreamDecoder().push(Buffer.alloc(1024 * 1024 + 1, 10))).not.toThrow();
    expect(() =>
      createClaudeStreamDecoder().push(Buffer.from('x'.repeat(1024 * 1024 + 1) + '\n')),
    ).toThrow('output limit');
  });
});
