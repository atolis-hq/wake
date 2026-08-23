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

  it.each([
    ['DONE', '**Outcome:** \u2705 Done'],
    ['REJECTED', '**Outcome:** \u{1F534} Changes Requested'],
    ['BLOCKED', '**Outcome:** \u{1F7E0} Blocked'],
    ['FAILED', '**Outcome:** \u274C Failed'],
    ['NEEDS_CLARIFICATION', '**Outcome:** \u{1F7E0} Needs clarification'],
  ] as const)('renders the exact outcome header for %s', (outcome, expectedHeader) => {
    const comment = formatAgentRunComment({
      idempotencyKey: 'k4',
      displayBody: 'Completed.',
      outcome,
      metadata: {},
    });

    expect(comment.split('\n')).toContain(expectedHeader);
  });

  it('preserves needs-clarification comment sections while changing only its header label', () => {
    const comment = formatAgentRunComment({
      idempotencyKey: 'agent-run:run-42',
      displayBody: '  ',
      outcome: 'NEEDS_CLARIFICATION',
      metadata: {},
      sessionId: 'session-42',
      workspacePath: '/workspace',
      watchGateVerdict: { runId: 'run-42' },
    });

    expect(comment).toContain('<!-- wake:agent -->');
    expect(comment).toContain('<!-- wake:delivery:agent-run:run-42 -->');
    expect(comment.split('\n')).toContain('**Outcome:** \u{1F7E0} Needs clarification');
    expect(comment).not.toContain('**Outcome:** \u{1F7E0} Blocked');
    expect(comment).toContain('Run blocked - needs input.');
    expect(comment).toContain('_Reply on this thread to continue.');
    expect(comment).toContain('cd "/workspace"\ncodex resume session-42');
    expect(comment).toContain('"watchGateVerdict"');
    expect(comment).toContain('"runId": "run-42"');
    expect(comment).toContain('"outcome": "NEEDS_CLARIFICATION"');
  });
});
