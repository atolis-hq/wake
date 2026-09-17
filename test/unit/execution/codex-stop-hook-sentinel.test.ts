import { describe, expect, it } from 'vitest';
import { humanInputRequiredMarker, inspectCodexTranscript } from '../../../src/execution/index.js';

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

  it.each(['BLOCKED', 'NEEDS_CLARIFICATION'])(
    'rejects a terminal %s status without a concrete human action',
    (status) => {
      expect(
        inspectCodexTranscript(transcript(`The integration test is still missing.\n\n${status}`)),
      ).toEqual({
        decision: 'block',
        reason: expect.stringContaining(humanInputRequiredMarker),
      });
    },
  );

  it('allows a blocked status with a concrete human action', () => {
    expect(
      inspectCodexTranscript(
        transcript(
          `The required product behavior is not specified.\n${humanInputRequiredMarker} Choose whether valid deliveries return 200 or 202.\nBLOCKED`,
        ),
      ),
    ).toEqual({});
  });

  it('does not treat a non-terminal blocked word as a result', () => {
    expect(
      inspectCodexTranscript(transcript('A prior run was BLOCKED, but this work is done.')),
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
