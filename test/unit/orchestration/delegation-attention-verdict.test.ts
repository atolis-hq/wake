import { expect, it } from 'vitest';
import { attentionVerdict } from '../../../src/orchestration/application/delegation-attention-state.js';

const outcome = (kind: string, data: unknown) => ({ kind, data }) as never;

it('leaves a done assessment unremarkable', () => {
  expect(attentionVerdict(outcome('done', { status: 'DONE' }))).toEqual({});
});

it.each([
  ['blocked', { status: 'NEEDS_CLARIFICATION', question: 'Which API?' }, 'Which API?'],
  ['blocked', { status: 'BLOCKED', message: 'Need a decision' }, 'Need a decision'],
  // A deliberate FAILED the parent agent reports is a human-visible escalation, not a retry.
  ['failed', { status: 'FAILED', message: 'The work cannot proceed' }, 'The work cannot proceed'],
])('escalates a structured %s result to a human', (kind, data, text) => {
  const verdict = attentionVerdict(outcome(kind, data));
  expect(verdict.escalation).toBe(text);
  expect(verdict.failure).toBeUndefined();
});

it.each([
  ['failed', { reason: 'runner-failed', message: 'timeout' }, 'runner-failed'],
  ['failed', { reason: 'invalid-agent-result' }, 'invalid-agent-result'],
  ['blocked', { reason: 'ambiguous-runner-result' }, 'ambiguous-runner-result'],
  ['blocked', { reason: 'runner-authentication-required' }, 'runner-authentication-required'],
  // Unverified completion carries status BLOCKED but is a run problem, never a published question.
  [
    'blocked',
    { status: 'BLOCKED', unverifiedCompletionReason: 'no commits observed' },
    'no commits observed',
  ],
  ['rejected', { status: 'REJECTED' }, 'rejected'],
])('treats a %s infrastructure result as a failed assessment run', (kind, data, reason) => {
  const verdict = attentionVerdict(outcome(kind, data));
  expect(verdict.escalation).toBeUndefined();
  expect(verdict.failure).toBe(reason);
});
