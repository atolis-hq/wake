export const stageValues = [
  'queue',
  'refined',
  'active',
  'awaiting-approval',
  'blocked',
  'done',
  'failed',
] as const;

export const runnerSentinelValues = ['DONE', 'BLOCKED', 'FAILED', 'AWAITING_APPROVAL'] as const;

export const agentActionValues = ['refine', 'implement'] as const;
