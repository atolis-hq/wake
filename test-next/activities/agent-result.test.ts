import { describe, expect, it } from 'vitest';
import { translateAgentResult } from '../../src-next/activities/index.js';
describe('agent results', () => {
  it.each([
    ['DONE', 'done'],
    ['REJECTED', 'rejected'],
    ['BLOCKED', 'blocked'],
    ['FAILED', 'failed'],
  ] as const)('maps %s', (status, kind) =>
    expect(translateAgentResult({ status })).toEqual({ kind, data: { status } }),
  );
  it('never treats missing structured agent output as done', () =>
    expect(translateAgentResult(undefined)).toEqual({
      kind: 'failed',
      data: { reason: 'invalid-agent-result' },
    }));
});
