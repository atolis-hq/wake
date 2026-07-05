export const stageValues = [
  'queue',
  'refined',
  'active',
  'blocked',
  'done',
  'failed',
] as const;

export const runnerSentinelValues = ['DONE', 'BLOCKED', 'FAILED'] as const;

export const agentActionValues = ['refine', 'implement'] as const;
