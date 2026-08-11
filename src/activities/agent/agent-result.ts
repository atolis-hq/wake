import { z } from 'zod';
import { ActivityFailureCode, ActivityOutcomeKind } from '../contracts/vocabulary.js';

export const reportedArtifactSchema = z
  .object({
    kind: z.string().min(1),
    externalKey: z.object({ adapter: z.string().min(1), key: z.string().min(1) }).strict(),
  })
  .strict();

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
  const structured = value as Record<string, unknown> & { readonly status: string };
  switch (structured.status) {
    case 'DONE':
      return terminalResult(ActivityOutcomeKind.Done, structured);
    case 'REJECTED':
      return terminalResult(ActivityOutcomeKind.Rejected, structured);
    case 'BLOCKED':
      return terminalResult(ActivityOutcomeKind.Blocked, structured);
    case 'FAILED':
      return terminalResult(ActivityOutcomeKind.Failed, structured);
    default:
      return {
        kind: ActivityOutcomeKind.Failed,
        data: { reason: ActivityFailureCode.InvalidAgentResult },
      };
  }
}

function terminalResult(
  kind: AgentActivityOutcome['kind'],
  value: Record<string, unknown> & { readonly status: string },
): AgentActivityOutcome {
  const { reportedArtifacts, ...data } = value;
  const artifacts = Array.isArray(reportedArtifacts)
    ? reportedArtifacts
        .map((artifact) => reportedArtifactSchema.safeParse(artifact))
        .flatMap((result) => (result.success ? [result.data] : []))
    : [];
  return {
    kind,
    data: {
      ...data,
      status: value.status,
      ...(artifacts.length === 0 ? {} : { reportedArtifacts: artifacts }),
    },
  } as AgentActivityOutcome;
}
