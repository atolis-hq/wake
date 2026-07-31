import type { ApiCommandStatus } from './control-plane.js';

const commandStatusShape = { accepted: true, completed: true };
const commandStatuses = Object.keys(commandStatusShape);

export const AcceptedCommandStatusValue = {
  Accepted: commandStatuses[0]! as ApiCommandStatus,
  Completed: commandStatuses[1]! as ApiCommandStatus,
} as const;

const runResponseShape = { active: true };

export const RunResponseField = { Active: Object.keys(runResponseShape)[0]! } as const;
