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
export type OrchestrationGroupStreamId = Brand<string, 'OrchestrationGroupStreamId'>;
export type OrchestrationGroupStreamRef = EntityRef<
  typeof OrchestrationStreamKind.Group,
  OrchestrationGroupStreamId
>;

export const workflowInstanceStream = (id: WorkflowInstanceId): WorkflowInstanceStreamRef => ({
  kind: OrchestrationStreamKind.WorkflowInstance,
  id,
});

export const primaryOrchestrationGroupStream = (
  workItemId: WorkItemId,
): OrchestrationGroupStreamRef => orchestrationGroupStream(`primary:${workItemId}`);

export const childOrchestrationGroupStream = (
  orchestrationGroupId: string,
  watchId: string,
): OrchestrationGroupStreamRef =>
  orchestrationGroupStream(`group:${component(orchestrationGroupId)}:watch:${component(watchId)}`);

export const isWorkflowInstanceStream = (stream: EntityRef): stream is WorkflowInstanceStreamRef =>
  stream.kind === OrchestrationStreamKind.WorkflowInstance;

export const isOrchestrationGroupStream = (
  stream: EntityRef,
): stream is OrchestrationGroupStreamRef => stream.kind === OrchestrationStreamKind.Group;

function orchestrationGroupStream(key: string): OrchestrationGroupStreamRef {
  if (!/^(?:primary:work-[a-z0-9-]+|group:[^:]+:watch:[^:]+)$/.test(key)) {
    throw new Error(`Invalid orchestration group stream key: ${key}`);
  }
  return {
    kind: OrchestrationStreamKind.Group,
    id: key as OrchestrationGroupStreamId,
  };
}

function component(value: string): string {
  if (value.trim().length === 0) throw new Error('Orchestration group key part must not be empty');
  return encodeURIComponent(value);
}
