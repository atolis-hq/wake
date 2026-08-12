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
  if (typeof value === 'string') return translateRawAgentResult(value);
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

function translateRawAgentResult(output: string): AgentActivityOutcome {
  try {
    return translateAgentResult(JSON.parse(output));
  } catch {
    const status = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1);
    return translateAgentResult({
      status: status ?? output.trim(),
      reportedArtifacts: wakeArtifacts(output),
    });
  }
}

function wakeArtifacts(output: string): readonly unknown[] {
  const artifacts: unknown[] = [];
  for (const match of output.matchAll(/```wake-artifacts\s*([\s\S]*?)```/g)) {
    if (match[1] === undefined) continue;
    try {
      const value = JSON.parse(match[1]) as { readonly artifacts?: unknown };
      if (!Array.isArray(value.artifacts)) continue;
      artifacts.push(...value.artifacts.flatMap(normalizeWakeArtifact));
    } catch {
      // A malformed artifact fence is ordinary agent prose, never an artifact claim.
    }
  }
  return artifacts;
}

function normalizeWakeArtifact(value: unknown): readonly unknown[] {
  if (typeof value !== 'object' || value === null) return [];
  const artifact = value as { readonly kind?: unknown; readonly url?: unknown };
  if (
    (artifact.kind !== 'pr' && artifact.kind !== 'pull-request') ||
    typeof artifact.url !== 'string'
  )
    return [];
  const match =
    /^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<number>[1-9]\d*)\/?$/.exec(
      artifact.url,
    );
  if (match?.groups === undefined) return [];
  return [
    {
      kind: 'pull-request',
      externalKey: {
        adapter: 'github',
        key: `${match.groups.owner!}/${match.groups.repo!}#${match.groups.number!}`,
      },
    },
  ];
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
