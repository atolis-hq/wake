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
  reportedArtifactSchema,
  runRecordSchema,
  sourceStateRecordSchema,
  wakeConfigSchema,
  wakeResultEnvelopeSchema,
  workItemCreatedPayloadSchema,
} from './schema.js';
import {
  runnerSentinelValues,
} from './stages.js';

export type Stage = string;
export type RunnerSentinel = (typeof runnerSentinelValues)[number];
export type AgentAction = string;

// correlatedResources is always present on the schema's true parsed output
// (zod's `.default([])` guarantees it), so the read type keeps it required —
// an optional marker here would be a lie about runtime and would push
// pointless `?? []` guards onto every consumer. Call sites that build a raw
// IssueStateRecord literal without going through parseIssueStateRecord
// (test fixtures) simply include `correlatedResources: []` explicitly.
export type IssueStateRecord = z.infer<typeof issueStateRecordSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type WakeLedger = z.infer<typeof ledgerSchema>;
export type WakeConfig = z.infer<typeof wakeConfigSchema>;
export type WorkflowDefinition = WakeConfig['workflows'][string];
export type WorkflowStageDefinition = WorkflowDefinition['stages'][string];
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
export type ReportedArtifact = z.infer<typeof reportedArtifactSchema>;
