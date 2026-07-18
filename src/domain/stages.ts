export const stageValues = [
  'queue',
  'refine',
  'implement',
  'done',
] as const;

export const doneRunnerSentinel = 'DONE';
export const blockedRunnerSentinel = 'BLOCKED';
export const failedRunnerSentinel = 'FAILED';
export const awaitingApprovalRunnerSentinel = 'AWAITING_APPROVAL';

export const runnerSentinelValues = [
  doneRunnerSentinel,
  blockedRunnerSentinel,
  failedRunnerSentinel,
  awaitingApprovalRunnerSentinel,
] as const;

export const agentActionValues = ['refine', 'implement'] as const;

export const terminalStageValues = ['done'] as const;

type Stage = string;

export function isTerminalStage(stage: Stage): boolean {
  return (terminalStageValues as readonly string[]).includes(stage);
}

export const wakeStageLabelPrefix = 'wake:stage.';

export function stageLabelForStage(stage: Stage): string {
  return `${wakeStageLabelPrefix}${stage}`;
}

export function stageFromStageLabel(
  label: string,
  configuredStages: Iterable<string> = stageValues,
): Stage | undefined {
  if (!label.startsWith(wakeStageLabelPrefix)) {
    return undefined;
  }

  const stage = label.slice(wakeStageLabelPrefix.length);
  return new Set(configuredStages).has(stage) ? stage : undefined;
}

export function stageFromLabels(
  labels: string[],
  configuredStages: Iterable<string> = stageValues,
): Stage | undefined {
  const stages = new Set<Stage>();

  for (const label of labels) {
    const stage = stageFromStageLabel(label, configuredStages);
    if (stage !== undefined) {
      stages.add(stage);
    }
  }

  return stages.size === 1 ? [...stages][0] : undefined;
}
