export const stageValues = [
  'queue',
  'refine',
  'implement',
  'done',
  'awaiting-approval',
  'blocked',
  'failed',
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

export const terminalStageValues = ['done', 'failed'] as const;

type Stage = (typeof stageValues)[number];

export function isTerminalStage(stage: Stage): boolean {
  return (terminalStageValues as readonly string[]).includes(stage);
}

export const wakeStageLabelPrefix = 'wake:stage.';

export function stageLabelForStage(stage: Stage): string {
  return `${wakeStageLabelPrefix}${stage}`;
}

export function stageFromStageLabel(label: string): Stage | undefined {
  if (!label.startsWith(wakeStageLabelPrefix)) {
    return undefined;
  }

  const stage = label.slice(wakeStageLabelPrefix.length);
  return stageValues.includes(stage as Stage) ? (stage as Stage) : undefined;
}

export function stageFromLabels(labels: string[]): Stage | undefined {
  const stages = new Set<Stage>();

  for (const label of labels) {
    const stage = stageFromStageLabel(label);
    if (stage !== undefined) {
      stages.add(stage);
    }
  }

  return stages.size === 1 ? [...stages][0] : undefined;
}
