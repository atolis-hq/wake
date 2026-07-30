import type { ActivityOutcome } from '../contracts/activity.js';
export function translateAgentResult(value: unknown): ActivityOutcome {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('status' in value) ||
    typeof value.status !== 'string'
  )
    return { kind: 'failed', data: { reason: 'invalid-agent-result' } };
  const kind = (
    { DONE: 'done', REJECTED: 'rejected', BLOCKED: 'blocked', FAILED: 'failed' } as Record<
      string,
      string
    >
  )[value.status];
  return kind === undefined
    ? { kind: 'failed', data: { reason: 'invalid-agent-result' } }
    : { kind, data: value };
}
