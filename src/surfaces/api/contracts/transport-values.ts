import type { ActivityOutcomeKind } from '../../../activities/index.js';
import type {
  ManualTriggerDisposition,
  TriggerRequestDisposition,
  TriggerSkipReason,
  TriggerSourceKind,
} from '../../../control-plane/index.js';
import type { RecoveryBlockReasonPrefix, RunStatus } from '../../../execution/index.js';
import { defineClosedVocabulary } from '../../../kernel/index.js';
import type { WorkflowStatus } from '../../../orchestration/index.js';
import type { ApiCommandStatus } from './control-plane.js';
import type { TriggerCommandName } from './triggers.js';

const commandStatusShape = { accepted: true, completed: true };
const commandStatuses = Object.keys(commandStatusShape);

export const AcceptedCommandStatusValue = {
  Accepted: commandStatuses[0]! as ApiCommandStatus,
  Completed: commandStatuses[1]! as ApiCommandStatus,
} as const;

const runResponseShape = { active: true };

export const RunResponseField = { Active: Object.keys(runResponseShape)[0]! } as const;

const resourceItemFieldShape = { adapter: true };

export const ResourceItemField = { Adapter: Object.keys(resourceItemFieldShape)[0]! } as const;

const runResolutionStatusShape = { failed: true, succeeded: true };
const runResolutionStatuses = Object.keys(runResolutionStatusShape);

export const RunResolutionStatusValue = {
  Failed: runResolutionStatuses[0]! as RunStatus,
  Succeeded: runResolutionStatuses[1]! as RunStatus,
} as const;

const boardActiveRunPhaseShape = { starting: true, started: true };
const boardActiveRunPhases = Object.keys(boardActiveRunPhaseShape);

export const BoardActiveRunPhaseValue = {
  Starting: boardActiveRunPhases[0]! as Extract<RunStatus, keyof typeof boardActiveRunPhaseShape>,
  Started: boardActiveRunPhases[1]! as Extract<RunStatus, keyof typeof boardActiveRunPhaseShape>,
} as const;

// Keep the browser transport independent of the activity implementation graph.
export const ActivityOutcomeKindValue: typeof ActivityOutcomeKind = defineClosedVocabulary({
  Waiting: 'waiting',
  Done: 'done',
  Rejected: 'rejected',
  Blocked: 'blocked',
  Failed: 'failed',
  Integrated: 'integrated',
} as const);

const boardConditionShape = {
  ready: true,
  active: true,
  'needs-input': true,
  error: true,
  finished: true,
};
const boardConditions = Object.keys(boardConditionShape);

export const BoardConditionValue = {
  Ready: boardConditions[0]!,
  Active: boardConditions[1]!,
  NeedsInput: boardConditions[2]!,
  Error: boardConditions[3]!,
  Finished: boardConditions[4]!,
} as const;

const boardCardFieldShape = { stage: true };

export const BoardCardField = { Stage: Object.keys(boardCardFieldShape)[0]! } as const;

const transcriptChannelShape = { input: true, agent: true };
const transcriptChannels = Object.keys(transcriptChannelShape);

export const TranscriptChannelValue = {
  Input: transcriptChannels[0]!,
  Agent: transcriptChannels[1]!,
} as const;

const transcriptGroupKindShape = { session: true, run: true };
const transcriptGroupKinds = Object.keys(transcriptGroupKindShape);

export const TranscriptGroupKindValue = {
  Session: transcriptGroupKinds[0]!,
  Run: transcriptGroupKinds[1]!,
} as const;

// Trigger transport vocabulary avoids importing the server implementation into the browser.
export const TriggerSourceKindValue: typeof TriggerSourceKind = {
  Event: 'event',
  Cron: 'cron',
  Manual: 'manual',
} as const;

const manualStartedShape = { started: true };

export const TriggerRequestDispositionValue: typeof TriggerRequestDisposition = {
  Started: Object.keys(manualStartedShape)[0]! as keyof typeof manualStartedShape,
  Coalesced: 'coalesced',
  Skipped: 'skipped',
} as const;

export const TriggerSkipReasonValue: typeof TriggerSkipReason = {
  OwnScope: 'own-scope',
  Paused: 'paused',
  Removed: 'removed',
  DispatchPaused: 'dispatch-paused',
  Capacity: 'capacity-unavailable',
  PendingLimit: 'pending-source-limit',
} as const;
const triggerFinishedStatusShape = { completed: true, superseded: true };
const triggerFinishedStatuses = Object.keys(
  triggerFinishedStatusShape,
) as (keyof typeof triggerFinishedStatusShape)[];

export const TriggerFinishedStatusValue = {
  Completed: triggerFinishedStatuses[0]!,
  Superseded: triggerFinishedStatuses[1]!,
} as const;

export const ManualTriggerDispositionValue: typeof ManualTriggerDisposition = {
  Started: Object.keys(manualStartedShape)[0]! as keyof typeof manualStartedShape,
  Coalesced: TriggerRequestDispositionValue.Coalesced,
  Skipped: TriggerRequestDispositionValue.Skipped,
} as const;

const triggerCommandShape = { pause: true, resume: true, run: true };
const triggerCommands = Object.keys(triggerCommandShape) as (keyof typeof triggerCommandShape)[];

export const TriggerCommandNameValue: typeof TriggerCommandName = {
  Pause: triggerCommands[0]!,
  Resume: triggerCommands[1]!,
  Run: triggerCommands[2]!,
};

export const WorkflowStatusValue: typeof WorkflowStatus = defineClosedVocabulary({
  Active: 'active',
  Waiting: 'waiting',
  Completed: 'completed',
  Blocked: 'blocked',
  Superseded: 'superseded',
} as const);

const recoveryBlockReasonShape = { 'execution-recovery-ambiguous:': true };

export const RecoveryBlockReasonPrefixValue = Object.keys(
  recoveryBlockReasonShape,
)[0]! as typeof RecoveryBlockReasonPrefix;

export function isAmbiguityResolutionBlockReasonValue(reason: string | undefined): boolean {
  return (
    reason?.startsWith(RecoveryBlockReasonPrefixValue) === true ||
    (reason !== undefined && /^run-ambiguous-after-\d+-attempts$/.test(reason))
  );
}
