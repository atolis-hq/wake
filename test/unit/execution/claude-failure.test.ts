import { expect, it } from 'vitest';
import { ClaudeAuthenticationFailureKind } from '../../../src/activities/index.js';
import { ProviderQuotaExceededFailureKind } from '../../../src/execution/index.js';
import { classifyClaudeFailure } from '../../../src/execution/infrastructure/runners/claude.js';

it.each(['Rate limit exceeded', 'Usage limit reached', 'Too many requests (429)'])(
  'classifies structured quota: %s',
  (result) => {
    expect(
      classifyClaudeFailure({ stdout: JSON.stringify({ is_error: true, result }), stderr: '' }),
    ).toEqual({ kind: ProviderQuotaExceededFailureKind, message: result });
  },
);

it('classifies expired OAuth separately from quota, preserving the real message', () => {
  const message = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  expect(
    classifyClaudeFailure({
      stdout: JSON.stringify({ is_error: true, result: message }),
      stderr: '',
    }),
  ).toEqual({ kind: ClaudeAuthenticationFailureKind, message });
});

it('preserves plain stderr quota handling', () => {
  expect(classifyClaudeFailure({ stdout: '', stderr: 'Rate limit exceeded' })).toEqual({
    kind: ProviderQuotaExceededFailureKind,
    message: 'Rate limit exceeded',
  });
});

it.each([
  '{',
  '{"is_error":true,"result":42}',
  '{"is_error":true,"result":"other failure"}',
  '{"is_error":false,"result":"finished"}',
])('leaves malformed or unrecognized output to the process fallback: %s', (stdout) =>
  expect(classifyClaudeFailure({ stdout, stderr: '' })).toBeUndefined(),
);
