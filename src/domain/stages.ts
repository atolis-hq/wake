export const stageValues = [
  'queue',
  'refined',
  'active',
  'awaiting-approval',
  'blocked',
  'done',
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
