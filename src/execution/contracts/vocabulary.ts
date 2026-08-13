import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

export const RunStatus = defineClosedVocabulary({
  Started: 'started',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Ambiguous: 'ambiguous',
} as const);

export type RunStatus = ValueOf<typeof RunStatus>;

export type FinishedRunStatus = Exclude<RunStatus, typeof RunStatus.Started>;

export const ExecutionFailureCode = defineClosedVocabulary({
  Unexpected: 'unexpected-execution-failure',
} as const);

export type ExecutionFailureCode = ValueOf<typeof ExecutionFailureCode>;

export const ExecutionCancellationReason = defineClosedVocabulary({
  Operator: 'operator',
  WorkCancelled: 'work-cancelled',
  WorkClosed: 'work-closed',
  WorkflowSuperseded: 'workflow-superseded',
  Timeout: 'timeout',
  Shutdown: 'shutdown',
  Maintenance: 'maintenance',
} as const);

export type ExecutionCancellationReason = ValueOf<typeof ExecutionCancellationReason>;

export const ExternalExecutionState = defineClosedVocabulary({
  Running: 'running',
  Completed: 'completed',
  Absent: 'absent',
  Unknown: 'unknown',
} as const);

export type ExternalExecutionState = ValueOf<typeof ExternalExecutionState>;

export const WorkspaceMode = defineClosedVocabulary({
  None: 'none',
  ReadOnly: 'read-only',
  Branch: 'branch',
} as const);

export type WorkspaceMode = ValueOf<typeof WorkspaceMode>;

const transcriptChannelShape = { input: true, agent: true };
const transcriptChannels = Object.keys(transcriptChannelShape);

export const TranscriptChannel = {
  Input: transcriptChannels[0]!,
  Agent: transcriptChannels[1]!,
} as const;

export type TranscriptChannel = ValueOf<typeof TranscriptChannel>;

const transcriptGroupKindShape = { session: true, run: true };
const transcriptGroupKinds = Object.keys(transcriptGroupKindShape);

export const TranscriptGroupKind = {
  Session: transcriptGroupKinds[0]!,
  Run: transcriptGroupKinds[1]!,
} as const;

export type TranscriptGroupKind = ValueOf<typeof TranscriptGroupKind>;
