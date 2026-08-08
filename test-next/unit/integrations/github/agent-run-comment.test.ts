import { describe, expect, it } from 'vitest';
import { formatAgentRunComment } from '../../../../src-next/integrations/github/application/agent-run-comment.js';

describe('formatAgentRunComment', () => {
  it('renders the watch-gate verdict marker when present', () => {
    const comment = formatAgentRunComment({
      idempotencyKey: 'k1',
      displayBody: 'Needs another pass on error handling.',
      outcome: 'REJECTED',
      metadata: {},
      watchGateVerdict: { runId: 'run-42' },
    });

    expect(comment).toContain('```json');
    expect(comment).toContain('"watchGateVerdict"');
    expect(comment).toContain('"runId": "run-42"');
    expect(comment).toContain('"outcome": "REJECTED"');
  });

  it('renders no marker when watchGateVerdict is absent', () => {
    const comment = formatAgentRunComment({
      idempotencyKey: 'k2',
      displayBody: 'Done.',
      outcome: 'DONE',
      metadata: {},
    });

    expect(comment).not.toContain('watchGateVerdict');
  });
});
