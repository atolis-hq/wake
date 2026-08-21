import { ActivityOutcomeKind } from '../../../activities/index.js';
import type { RunStatus } from '../../../execution/index.js';
import type { ApiCommandStatus } from './control-plane.js';

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

export const ActivityOutcomeKindValue = ActivityOutcomeKind;

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
