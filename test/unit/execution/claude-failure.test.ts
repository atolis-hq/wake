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

// Trimmed from a live corum#135 review run: the 5-hour-limit text matched no quota phrase, so the
// run was recorded as a plain runner failure and its retry was spent instead of falling back.
const liveUsageLimit = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  terminal_reason: 'api_error',
  api_error_status: 429,
  api_error_type: 'rate_limit_error',
  api_error: 'usage_limit_reached',
  result: "You've hit your 5-hour limit · resets 1:10pm (UTC)",
};

it('classifies the CLI usage-limit result as quota from its API error fields', () => {
  expect(
    classifyClaudeFailure({ stdout: JSON.stringify(liveUsageLimit) + '\n', stderr: '' }),
  ).toEqual({ kind: ProviderQuotaExceededFailureKind, message: liveUsageLimit.result });
});

it.each([
  { api_error_status: 429 },
  { api_error_type: 'rate_limit_error' },
  { api_error: 'usage_limit_reached' },
])('classifies a structured rate-limit field whatever the result text: %o', (fields) => {
  expect(
    classifyClaudeFailure({
      stdout: JSON.stringify({ is_error: true, result: 'Request failed', ...fields }),
      stderr: '',
    }),
  ).toEqual({ kind: ProviderQuotaExceededFailureKind, message: 'Request failed' });
});

it('classifies the plain-text usage-limit phrasing as quota', () => {
  expect(classifyClaudeFailure({ stdout: '', stderr: "You've hit your weekly limit" })).toEqual({
    kind: ProviderQuotaExceededFailureKind,
    message: "You've hit your weekly limit",
  });
});

it('keeps an authentication failure ahead of a 429 status', () => {
  const message = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  expect(
    classifyClaudeFailure({
      stdout: JSON.stringify({ is_error: true, result: message, api_error_status: 429 }),
      stderr: '',
    }),
  ).toEqual({ kind: ClaudeAuthenticationFailureKind, message });
});
