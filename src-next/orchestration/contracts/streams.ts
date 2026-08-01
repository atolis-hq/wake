import type { Brand, EntityRef } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { WorkflowInstanceId } from './identifiers.js';

export const OrchestrationStreamKind = {
  WorkflowInstance: 'workflow-instance',
  Group: 'orchestration-group',
} as const;

export type WorkflowInstanceStreamRef = EntityRef<
  typeof OrchestrationStreamKind.WorkflowInstance,
  WorkflowInstanceId
>;

export type PrimaryOrchestrationGroupStreamId = Brand<string, 'PrimaryOrchestrationGroupStreamId'>;

export type ChildOrchestrationGroupStreamId = Brand<string, 'ChildOrchestrationGroupStreamId'>;

export type OrchestrationGroupStreamId =
  PrimaryOrchestrationGroupStreamId | ChildOrchestrationGroupStreamId;

export type PrimaryOrchestrationGroupStreamRef = EntityRef<
  typeof OrchestrationStreamKind.Group,
  PrimaryOrchestrationGroupStreamId
>;

export type ChildOrchestrationGroupStreamRef = EntityRef<
  typeof OrchestrationStreamKind.Group,
  ChildOrchestrationGroupStreamId
>;

export type OrchestrationGroupStreamRef =
  PrimaryOrchestrationGroupStreamRef | ChildOrchestrationGroupStreamRef;

export const orchestrationGroupStreamId = (value: string): OrchestrationGroupStreamId => {
  return value.startsWith('primary:')
    ? primaryOrchestrationGroupStreamId(value)
    : childOrchestrationGroupStreamId(value);
};

export const primaryOrchestrationGroupStreamId = (
  value: string,
): PrimaryOrchestrationGroupStreamId => {
  if (!/^primary:work-[a-z0-9-]+$/.test(value))
    throw new Error(`Invalid primary orchestration group stream key: ${value}`);
  return value as PrimaryOrchestrationGroupStreamId;
};

export const childOrchestrationGroupStreamId = (value: string): ChildOrchestrationGroupStreamId => {
  if (!/^group:[^:]+:watch:[^:]+$/.test(value))
    throw new Error(`Invalid child orchestration group stream key: ${value}`);
  return value as ChildOrchestrationGroupStreamId;
};

export const workflowInstanceStream = (id: WorkflowInstanceId): WorkflowInstanceStreamRef => ({
  kind: OrchestrationStreamKind.WorkflowInstance,
  id,
});

export const primaryOrchestrationGroupStream = (
  workItemId: WorkItemId,
): PrimaryOrchestrationGroupStreamRef => ({
  kind: OrchestrationStreamKind.Group,
  id: primaryOrchestrationGroupStreamId(`primary:${workItemId}`),
});

export const childOrchestrationGroupStream = (
  orchestrationGroupId: string,
  watchId: string,
): ChildOrchestrationGroupStreamRef => ({
  kind: OrchestrationStreamKind.Group,
  id: childOrchestrationGroupStreamId(
    `group:${component(orchestrationGroupId)}:watch:${component(watchId)}`,
  ),
});

export const isWorkflowInstanceStream = (stream: EntityRef): stream is WorkflowInstanceStreamRef =>
  stream.kind === OrchestrationStreamKind.WorkflowInstance;

export const isOrchestrationGroupStream = (
  stream: EntityRef,
): stream is OrchestrationGroupStreamRef => stream.kind === OrchestrationStreamKind.Group;

function component(value: string): string {
  if (value.trim().length === 0) throw new Error('Orchestration group key part must not be empty');
  return encodeURIComponent(value);
}
