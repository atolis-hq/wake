import { ActivityFailureCode, ActivityOutcomeKind } from '../contracts/vocabulary.js';
import { z } from 'zod';

const structuredResult = <Status extends string>(status: Status) =>
  z.object({ status: z.literal(status) }).catchall(z.unknown());

const blockedReason = z
  .object({
    reason: z.literal(ActivityFailureCode.AmbiguousRunnerResult),
  })
  .strict();

const failedReason = z
  .object({
    reason: z.enum([ActivityFailureCode.InvalidAgentResult, ActivityFailureCode.RunnerFailed]),
    message: z.string().optional(),
  })
  .strict();

export const agentActivityOutcomeSchema = z.union([
  z
    .object({
      kind: z.literal(ActivityOutcomeKind.Done),
      data: structuredResult('DONE'),
    })
    .strict(),
  z
    .object({
      kind: z.literal(ActivityOutcomeKind.Rejected),
      data: structuredResult('REJECTED'),
    })
    .strict(),
  z
    .object({
      kind: z.literal(ActivityOutcomeKind.Blocked),
      data: z.union([structuredResult('BLOCKED'), blockedReason]),
    })
    .strict(),
  z
    .object({
      kind: z.literal(ActivityOutcomeKind.Failed),
      data: z.union([structuredResult('FAILED'), failedReason]),
    })
    .strict(),
]);

export type AgentActivityOutcome = z.output<typeof agentActivityOutcomeSchema>;

export const agentActivityOutcomeKinds = [
  ActivityOutcomeKind.Done,
  ActivityOutcomeKind.Rejected,
  ActivityOutcomeKind.Blocked,
  ActivityOutcomeKind.Failed,
] as const satisfies readonly AgentActivityOutcome['kind'][];

export function translateAgentResult(value: unknown): AgentActivityOutcome {
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
  switch (value.status) {
    case 'DONE':
      return { kind: ActivityOutcomeKind.Done, data: { ...value, status: value.status } };
    case 'REJECTED':
      return { kind: ActivityOutcomeKind.Rejected, data: { ...value, status: value.status } };
    case 'BLOCKED':
      return { kind: ActivityOutcomeKind.Blocked, data: { ...value, status: value.status } };
    case 'FAILED':
      return { kind: ActivityOutcomeKind.Failed, data: { ...value, status: value.status } };
    default:
      return {
        kind: ActivityOutcomeKind.Failed,
        data: { reason: ActivityFailureCode.InvalidAgentResult },
      };
  }
}
