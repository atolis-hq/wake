import { z } from 'zod';

import {
  claudePrintResultSchema,
  eventEnvelopeSchema,
  eventRecordSchema,
  issueStateRecordSchema,
  ledgerSchema,
  runRecordSchema,
  wakeConfigSchema,
} from './schema.js';
import {
  agentActionValues,
  runnerSentinelValues,
  stageValues,
} from './stages.js';

export type Stage = (typeof stageValues)[number];
export type RunnerSentinel = (typeof runnerSentinelValues)[number];
export type AgentAction = (typeof agentActionValues)[number];

export type IssueStateRecord = z.infer<typeof issueStateRecordSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type EventRecord = z.infer<typeof eventRecordSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type WakeLedger = z.infer<typeof ledgerSchema>;
export type WakeConfig = z.infer<typeof wakeConfigSchema>;
export type ClaudePrintResult = z.infer<typeof claudePrintResultSchema>;
