import type { CommandContext } from '@atolis-hq/eventing';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
  type StartWorkflowInstance,
  type WorkflowInstanceView,
} from '../../orchestration/index.js';
import { workItemId, type CreateWorkItem } from '../../work/index.js';
import type { ControlEventPayloads, ControlEventType } from '../contracts/events.js';

type Claim = ControlEventPayloads[typeof ControlEventType.TriggerInvocationClaimed];

export interface TriggerWorkflowPorts {
  readonly work: { create(command: CreateWorkItem, context: CommandContext): Promise<unknown> };
  readonly orchestration: {
    start(command: StartWorkflowInstance, context: CommandContext): Promise<unknown>;
    get(id: ReturnType<typeof workflowInstanceId>): Promise<WorkflowInstanceView | null>;
  };
}

/** Creates the top-level invocation WorkItem and workflow once; replays only read. */
export async function ensureTriggerWorkflow(
  ports: TriggerWorkflowPorts,
  claim: Claim,
  context: CommandContext,
): Promise<WorkflowInstanceView | null> {
  const workflow = workflowInstanceId(claim.workflowInstanceId);
  const existing = await ports.orchestration.get(workflow);
  if (existing !== null) return existing;
  const item = workItemId(claim.workItemId);
  await ports.work.create(
    { workItemId: item, objective: `Trigger ${claim.triggerId}: workflow ${claim.workflowName}` },
    context,
  );
  await ports.orchestration.start(
    {
      workflowInstanceId: workflow,
      workItemId: item,
      workflowName: workflowName(claim.workflowName),
      orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
    },
    context,
  );
  return ports.orchestration.get(workflow);
}
