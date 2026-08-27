import type { ConversationService } from '../../conversations/index.js';
import type { CommandContext } from '../../kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  type OrchestrationService,
} from '../../orchestration/index.js';
import {
  ResourceCorrelationRole,
  type ResourceCapability,
  type ResourceId,
  type ResourceKind,
  type ResourceService,
} from '../../resources/index.js';
import type { WorkItemId, WorkService } from '../../work/index.js';
import type { AdapterId } from '../contracts/identifiers.js';
import type { WorkflowRouter } from '../contracts/provider.js';

export interface WorkAdmissionServices {
  readonly work: WorkService;
  readonly conversations?: ConversationService;
  readonly resources: ResourceService;
  readonly orchestration: OrchestrationService;
  readonly routing: WorkflowRouter;
}

export interface AdmitObservedWork {
  readonly adapter: AdapterId;
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly kind: ResourceKind;
  readonly externalKey: { readonly adapter: AdapterId; readonly key: string };
  readonly capabilities: readonly ResourceCapability[];
  readonly objective: string;
  readonly tags: readonly string[];
  readonly revision?: string | undefined;
  readonly title?: string | undefined;
}

// The single place a newly observed external object becomes Wake work: discover the
// resource, create the WorkItem with its intake tags, correlate the two, then start the
// workflow configuration selects. No adapter proposes a workflow name.
export async function admitObservedWork(
  services: WorkAdmissionServices,
  input: AdmitObservedWork,
  context: CommandContext,
  // Provider evidence that the entry stage must already see, recorded before the start.
  beforeStart?: () => Promise<void>,
): Promise<void> {
  await services.resources.discover(
    {
      resourceId: input.resourceId,
      kind: input.kind,
      externalKey: input.externalKey,
      capabilities: input.capabilities,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      ...(input.title === undefined ? {} : { title: input.title }),
    },
    context,
  );
  await services.work.create(
    { workItemId: input.workItemId, objective: input.objective, tags: input.tags },
    context,
  );
  await services.conversations?.createForWorkItem(input.workItemId, context);
  await services.resources.correlate(
    input.resourceId,
    input.workItemId,
    ResourceCorrelationRole.Primary,
    context,
  );
  if (beforeStart !== undefined) await beforeStart();
  await services.orchestration.start(
    {
      workflowInstanceId: workflowInstanceId(`primary:${input.workItemId}`),
      workItemId: input.workItemId,
      workflowName: services.routing.select({
        tags: input.tags,
        kind: input.kind,
        adapter: input.adapter,
      }),
      orchestrationGroupId: orchestrationGroupId(`primary:${input.workItemId}`),
    },
    context,
  );
}
