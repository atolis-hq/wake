import { describe, expect, it } from 'vitest';
import { formatAgentRunComment } from '../../../../src/integrations/github/application/agent-run-comment.js';

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

  it('links the Wake header to the configured public UI URL', () => {
    const comment = formatAgentRunComment({
      idempotencyKey: 'k3',
      displayBody: 'Done.',
      outcome: 'DONE',
      metadata: {},
      publicUiUrl: 'https://wake.example.com',
    });

    expect(comment).toContain('**[Wake](https://wake.example.com)**');
  });

  it('labels needs-clarification outcomes without changing the blocked label', () => {
    const common = {
      idempotencyKey: 'k4',
      displayBody: 'Waiting for input.',
      metadata: {},
    };

    expect(formatAgentRunComment({ ...common, outcome: 'NEEDS_CLARIFICATION' })).toContain(
      '**Outcome:** \u{1F7E0} Needs clarification',
    );
    expect(formatAgentRunComment({ ...common, outcome: 'BLOCKED' })).toContain(
      '**Outcome:** \u{1F7E0} Blocked',
    );
  });
});
