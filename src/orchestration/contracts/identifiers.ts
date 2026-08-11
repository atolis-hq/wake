import type { Brand } from '../../kernel/index.js';

export type WorkflowName = Brand<string, 'WorkflowName'>;

export type StageName = Brand<string, 'StageName'>;

export type SignalName = Brand<string, 'SignalName'>;

export type CommandName = Brand<string, 'CommandName'>;

export type WorkflowInstanceId = Brand<string, 'WorkflowInstanceId'>;

export type OrchestrationGroupId = Brand<string, 'OrchestrationGroupId'>;

export type WatchId = Brand<string, 'WatchId'>;

export const workflowName = (value: string): WorkflowName => {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value))
    throw new Error(`Invalid workflow name: ${value}`);
  return value as WorkflowName;
};

export const stageName = (value: string): StageName => {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value))
    throw new Error(`Invalid stage name: ${value}`);
  return value as StageName;
};

export const signalName = (value: string): SignalName => {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value))
    throw new Error(`Invalid signal name: ${value}`);
  return value as SignalName;
};

export const commandName = (value: string): CommandName => {
  if (!/^\/[a-z][a-z0-9-]*$/.test(value)) throw new Error(`Invalid command name: ${value}`);
  return value as CommandName;
};

export const workflowInstanceId = (value: string): WorkflowInstanceId => {
  if (value.trim().length === 0) throw new Error('WorkflowInstance id must not be empty');
  return value as WorkflowInstanceId;
};

export const orchestrationGroupId = (value: string): OrchestrationGroupId => {
  if (value.trim().length === 0) throw new Error('Orchestration group id must not be empty');
  return value as OrchestrationGroupId;
};

export const watchId = (value: string): WatchId => {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new Error(`Invalid WatchId: ${value}`);
  return value as WatchId;
};
