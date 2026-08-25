import { describe, expect, it } from 'vitest';
import { inspectCodexTranscript } from '../../../src/execution/index.js';

describe('Codex Stop hook WAIT_BACKGROUND protocol', () => {
  it('blocks an exact final WAIT_BACKGROUND status', () => {
    expect(inspectCodexTranscript(transcript('WAIT_BACKGROUND'))).toEqual({
      decision: 'block',
      reason: expect.stringContaining('WAIT_BACKGROUND'),
    });
  });

  it('does not block prose that merely mentions the status', () => {
    expect(inspectCodexTranscript(transcript('I am WAIT_BACKGROUND now.'))).toEqual({});
  });

  it('does not block a WAIT_BACKGROUND commentary message', () => {
    expect(inspectCodexTranscript(transcript('WAIT_BACKGROUND', 'commentary'))).toEqual({});
  });

  it('does not block an earlier WAIT_BACKGROUND status after a normal final response', () => {
    expect(
      inspectCodexTranscript(`${transcript('WAIT_BACKGROUND')}\n${transcript('DONE')}`),
    ).toEqual({});
  });
});

function transcript(text: string, phase = 'final_answer'): string {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
      phase,
    },
  });
}
