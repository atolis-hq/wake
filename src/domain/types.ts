import { z } from 'zod';

import {
  claudePrintResultSchema,
  correlatedResourceSchema,
  correlationPrimaryConflictPayloadSchema,
  correlationRegisteredPayloadSchema,
  correlationRetractedPayloadSchema,
  eventEnvelopeSchema,
  issueStateRecordSchema,
  ledgerSchema,
  runRecordSchema,
  sourceStateRecordSchema,
  wakeConfigSchema,
  wakeResultEnvelopeSchema,
  workItemCreatedPayloadSchema,
} from './schema.js';
import {
  agentActionValues,
  runnerSentinelValues,
  stageValues,
} from './stages.js';

export type Stage = (typeof stageValues)[number];
export type RunnerSentinel = (typeof runnerSentinelValues)[number];
export type AgentAction = (typeof agentActionValues)[number];

// correlatedResources is required on the schema's true parsed output (zod's
// `.default([])` always fills it), but making it required on the exported
// TS type would force every existing call site across the codebase that
// builds an IssueStateRecord-shaped literal (test fixtures, adapters) to add
// it. Widening it to optional here keeps those call sites compiling; every
// value that actually flows through parseIssueStateRecord/readIssueState
// still gets a real array at runtime regardless of what the type says.
type ParsedIssueStateRecord = z.infer<typeof issueStateRecordSchema>;
export type IssueStateRecord = Omit<ParsedIssueStateRecord, 'correlatedResources'> & {
  correlatedResources?: ParsedIssueStateRecord['correlatedResources'];
};
export type RunRecord = z.infer<typeof runRecordSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type WakeLedger = z.infer<typeof ledgerSchema>;
export type WakeConfig = z.infer<typeof wakeConfigSchema>;
export type RunnerFailureClass = 'task' | 'quota' | 'infra';
export type RunnerRouting = NonNullable<RunRecord['routing']>;
export type RunnerEntry = WakeConfig['runners'][string];
export type RunnerKind = RunnerEntry['kind'];
export type WakePathsConfig = WakeConfig['paths'];
export type WakeSandboxConfig = WakeConfig['sandbox'];
export type WakeDevConfig = NonNullable<WakeConfig['dev']>;
export type ClaudePrintResult = z.infer<typeof claudePrintResultSchema>;
export type SourceStateRecord = z.infer<typeof sourceStateRecordSchema>;
export type WakeResultEnvelope = z.infer<typeof wakeResultEnvelopeSchema>;
export type WorkItemCreatedPayload = z.infer<typeof workItemCreatedPayloadSchema>;
export type CorrelationRegisteredPayload = z.infer<typeof correlationRegisteredPayloadSchema>;
export type CorrelationRetractedPayload = z.infer<typeof correlationRetractedPayloadSchema>;
export type CorrelationPrimaryConflictPayload = z.infer<typeof correlationPrimaryConflictPayloadSchema>;
export type CorrelatedResource = z.infer<typeof correlatedResourceSchema>;
