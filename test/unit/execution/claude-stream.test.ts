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

  it.each(['assistant', 'user', 'stream_event'])(
    'discards oversized %s records across chunks and decodes the following result',
    (type) => {
      const decoder = createClaudeStreamDecoder();
      const prefix = Buffer.from(
        JSON.stringify({ type, message: 'x'.repeat(1024 * 1024) }).slice(0, -2),
      );
      expect(decoder.push(prefix).activity).toBe(true);
      expect(decoder.push(Buffer.alloc(1024 * 1024, 120))).toEqual({
        output: Buffer.alloc(0),
        activity: true,
      });
      const final = JSON.stringify({ type: 'result', result: 'done' });
      const decoded = decoder.push(Buffer.from('"}\n' + final + '\n'));
      expect(decoded.output.toString()).toBe(final);
      expect(decoded.activity).toBe(true);
    },
  );

  it('observes incoming progress bytes during a fragmented large record without synthetic activity', () => {
    const decoder = createClaudeStreamDecoder();
    expect(decoder.push(Buffer.from('{"ty')).activity).toBe(false);
    expect(decoder.push(Buffer.from('pe":"assistant","message":"')).activity).toBe(true);
    expect(decoder.push(Buffer.alloc(1000, 120)).activity).toBe(true);
    expect(decoder.push(Buffer.alloc(0)).activity).toBe(false);
  });

  it('discards an oversized unrelated record without counting it as progress', () => {
    const decoder = createClaudeStreamDecoder();
    expect(
      decoder.push(
        Buffer.from(
          JSON.stringify({ type: 'system', message: 'x'.repeat(2 * 1024 * 1024) }) + '\n',
        ),
      ),
    ).toEqual({ output: Buffer.alloc(0), activity: false });
  });

  it('retains bounded plain-text failure diagnostics without counting them as progress', () => {
    const decoder = createClaudeStreamDecoder();
    expect(decoder.push(Buffer.from('Provider rate limit exceeded\n'))).toEqual({
      output: Buffer.alloc(0),
      activity: false,
    });
    expect(decoder.finish().toString()).toBe('Provider rate limit exceeded');
  });

  it('keeps preliminary diagnostics out of a successful final response', () => {
    const decoder = createClaudeStreamDecoder();
    const final = JSON.stringify({ type: 'result', result: 'done' });
    expect(
      decoder.push(Buffer.from('Preliminary warning\n' + final + '\n')).output.toString(),
    ).toBe(final);
    expect(decoder.finish()).toEqual(Buffer.alloc(0));
  });

  it('bounds final results, including incomplete records, before parsing', () => {
    const prefix = Buffer.from('{"type":"result","result":"');
    const decoder = createClaudeStreamDecoder();
    decoder.push(prefix);
    expect(() => decoder.push(Buffer.alloc(1024 * 1024, 120))).toThrow('output limit');
    expect(() =>
      createClaudeStreamDecoder().push(
        Buffer.from(JSON.stringify({ type: 'result', result: 'x'.repeat(1024 * 1024) }) + '\n'),
      ),
    ).toThrow('output limit');
  });
});
