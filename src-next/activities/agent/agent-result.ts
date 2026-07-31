import { ActivityFailureCode, ActivityOutcomeKind } from '../contracts/vocabulary.js';
import type { ActivityOutcome } from '../contracts/activity.js';
export function translateAgentResult(value: unknown): ActivityOutcome {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('status' in value) ||
    typeof value.status !== 'string'
  )
    return {
      kind: ActivityOutcomeKind.Failed,
      data: { reason: ActivityFailureCode.InvalidAgentResult },
    };
  const kind = (
    {
      DONE: ActivityOutcomeKind.Done,
      REJECTED: ActivityOutcomeKind.Rejected,
      BLOCKED: ActivityOutcomeKind.Blocked,
      FAILED: ActivityOutcomeKind.Failed,
    } as Record<string, string>
  )[value.status];
  return kind === undefined
    ? { kind: ActivityOutcomeKind.Failed, data: { reason: ActivityFailureCode.InvalidAgentResult } }
    : { kind, data: value };
}
