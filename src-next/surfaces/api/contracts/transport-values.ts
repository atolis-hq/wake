import type { ApiCommandStatus } from './control-plane.js';

const commandStatusShape = { accepted: true, completed: true };
const commandStatuses = Object.keys(commandStatusShape);

export const AcceptedCommandStatusValue = {
  Accepted: commandStatuses[0]! as ApiCommandStatus,
  Completed: commandStatuses[1]! as ApiCommandStatus,
} as const;

const runResponseShape = { active: true };

export const RunResponseField = { Active: Object.keys(runResponseShape)[0]! } as const;

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
