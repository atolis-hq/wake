import { ActivityOutcomeKind } from '../../../activities/index.js';
import { agentTokenUsage, RunStatus, type RunView } from '../../../execution/index.js';
import type { RunResponse } from '../contracts/execution.js';

const outcomeSentinels: Readonly<Record<ActivityOutcomeKind, string>> = {
  [ActivityOutcomeKind.Done]: 'DONE',
  [ActivityOutcomeKind.Rejected]: 'REJECTED',
  [ActivityOutcomeKind.Blocked]: 'BLOCKED',
  [ActivityOutcomeKind.Failed]: 'FAILED',
  [ActivityOutcomeKind.Waiting]: 'WAITING',
};

export function presentRun(value: RunView): RunResponse {
  const usage = agentTokenUsage(value.agent?.metadata);
  const sentinel =
    value.outcome?.kind !== undefined && isActivityOutcomeKind(value.outcome.kind)
      ? outcomeSentinels[value.outcome.kind]
      : value.status.toUpperCase();
  return {
    runId: value.runId,
    activationId: value.activationId,
    activity: value.activity,
    ...(value.stage === undefined ? {} : { stage: value.stage }),
    workflowInstanceId: value.workflowInstanceId,
    orchestrationGroupId: value.orchestrationGroupId,
    attempt: value.attempt,
    status: value.status,
    active: value.status === RunStatus.Started,
    startedAt: value.startedAt,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
    ...(value.failure === undefined ? {} : { failure: { kind: value.failure.kind } }),
    sentinel,
    ...(value.runner?.name === undefined ? {} : { runnerName: value.runner.name }),
    ...(value.runner?.model === undefined ? {} : { runnerModel: value.runner.model }),
    totalTokens: usage.tokens,
    ...tokenBreakdown(value.agent?.metadata),
    totalCostUsd: usage.costUsd,
  };
}

function tokenBreakdown(metadata: NonNullable<RunView['agent']>['metadata'] | undefined) {
  const numeric = (key: string): number | undefined => {
    const value = metadata?.[key];
    return typeof value === 'number' ? value : undefined;
  };
  const inputTokens = numeric('inputTokens');
  const outputTokens = numeric('outputTokens');
  if (inputTokens === undefined || outputTokens === undefined) return {};
  const cacheReadTokens = numeric('cacheReadTokens');
  const cacheWriteTokens = numeric('cacheWriteTokens');
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function isActivityOutcomeKind(kind: string): kind is ActivityOutcomeKind {
  return (Object.values(ActivityOutcomeKind) as readonly string[]).includes(kind);
}
