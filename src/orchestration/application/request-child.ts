import type { CommandContext } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type {
  ChildCompletionSignal,
  ChildCoordinationEventPayloads,
  ChildWorkflowRequest,
} from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { signalName, watchId, type WorkflowInstanceId } from '../contracts/identifiers.js';
import { childOrchestrationGroupStream } from '../contracts/streams.js';
import type {
  GroupBudgetExhaustedView,
  SignalExpectationView,
  WorkflowInstanceView,
} from '../contracts/views.js';
import { ApprovalAuthorityKind, WorkflowStatus } from '../contracts/vocabulary.js';
import { childMetadata, childRequestId, coordinationMetadata } from '../domain/child-policy.js';
import { coordinationDraft } from '../domain/coordination-events.js';
import { stateDraft } from '../domain/decision-events.js';
import { acceptSignal as decideSignal } from '../domain/interpreter.js';
import type { AdvanceWorkflow } from './advance-workflow.js';
import type { CoordinationClaims } from './coordination-claims.js';
import type { GroupBudgetRecorder } from './group-budget-recorder.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { StartWorkflow } from './start-workflow.js';

export class RequestChild {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly claims: CoordinationClaims,
    private readonly groupBudgets: GroupBudgetRecorder,
    private readonly workflows: StartWorkflow,
    private readonly advance: AdvanceWorkflow,
  ) {}

  async execute(
    request: ChildWorkflowRequest & { readonly maxPerGroup: number },
    context: CommandContext,
  ): Promise<WorkflowInstanceView | GroupBudgetExhaustedView> {
    const parent = await this.repository.loadRequired(request.parentWorkflowInstanceId);
    const id = childRequestId(request);
    if (request.requestId !== id)
      throw new Error('Child request id must be stable for its parent, watch, and trigger');
    const existing = await this.repository.load(id);
    if (existing.view !== null) return existing.view;
    const group = childOrchestrationGroupStream(parent.view.orchestrationGroupId, request.watchId);
    const metadata = coordinationMetadata(parent.view, request);
    if (!(await this.claims.claimWithinBudget(group, request, context))) {
      await this.groupBudgets.record(parent.view, metadata, request.maxPerGroup, context);
      return { kind: 'group-budget-exhausted', requestId: request.requestId };
    }
    return this.workflows.execute(
      {
        workflowInstanceId: id,
        workItemId: parent.view.workItemId,
        workflowName: request.workflowName,
        orchestrationGroupId: parent.view.orchestrationGroupId,
        parentWorkflowInstanceId: request.parentWorkflowInstanceId,
        watchId: request.watchId,
        triggerId: request.triggerId,
        causalCycleId: request.causalCycleId,
        requestId: request.requestId,
      },
      context,
    );
  }

  async rejectCausalActivation(
    request: ChildWorkflowRequest,
    context: CommandContext,
  ): Promise<WorkflowInstanceView> {
    const loaded = await this.repository.loadRequired(request.parentWorkflowInstanceId);
    if (loaded.view.causalRejectionIds.includes(request.triggerId)) return loaded.view;
    const metadata = coordinationMetadata(loaded.view, request);
    await this.repository.append(loaded.view.workflowInstanceId, loaded.sequence, [
      this.coordinationEvent(
        loaded.view,
        context,
        OrchestrationEventType.CausalActivationRejected,
        metadata,
        1,
      ),
      stateDraft(
        loaded.view,
        { occurredAt: context.occurredAt, causationId: context.commandId },
        OrchestrationEventType.InstanceBlocked,
        { reason: 'causal activation rejected' },
        2,
      ),
    ]);
    return (await this.repository.loadRequired(loaded.view.workflowInstanceId)).view;
  }

  async reconcileChildCompletions(context: CommandContext): Promise<void> {
    for (const child of await this.advance.listAll()) {
      if (child.parentWorkflowInstanceId !== undefined && child.status === WorkflowStatus.Completed)
        await this.complete(child, {
          ...context,
          commandId: `${context.commandId}:child:${child.workflowInstanceId}`,
        });
    }
  }

  async supersedeChildrenForWait(
    parentWorkflowInstanceId: WorkflowInstanceId,
    wait: SignalExpectationView | undefined,
    context: CommandContext,
  ): Promise<readonly WorkflowInstanceId[]> {
    const watchIds = watchIdsFor(wait);
    if (watchIds.length === 0) return [];
    const children = (await this.advance.listAll()).filter(
      (child) =>
        child.parentWorkflowInstanceId === parentWorkflowInstanceId &&
        child.watchId !== undefined &&
        watchIds.includes(child.watchId) &&
        child.status !== WorkflowStatus.Completed &&
        child.status !== WorkflowStatus.Superseded,
    );
    for (const child of children) {
      const loaded = await this.repository.loadRequired(child.workflowInstanceId);
      if (
        loaded.view.status === WorkflowStatus.Completed ||
        loaded.view.status === WorkflowStatus.Superseded
      )
        continue;
      await this.repository.append(child.workflowInstanceId, loaded.sequence, [
        stateDraft(
          loaded.view,
          { occurredAt: context.occurredAt, causationId: context.commandId },
          OrchestrationEventType.InstanceSuperseded,
          {},
          1,
        ),
      ]);
    }
    return children.map((child) => child.workflowInstanceId);
  }

  async validateChildDispatch(
    childWorkflowInstanceId: WorkflowInstanceId,
    context: CommandContext,
  ): Promise<boolean> {
    const child = await this.repository.loadRequired(childWorkflowInstanceId);
    if (child.view.parentWorkflowInstanceId === undefined) return true;
    const parent = await this.repository.loadRequired(child.view.parentWorkflowInstanceId);
    if (child.view.watchId !== undefined && parentWaitsForWatch(parent.view, child.view.watchId))
      return true;
    if (child.view.status !== WorkflowStatus.Superseded)
      await this.repository.append(childWorkflowInstanceId, child.sequence, [
        stateDraft(
          child.view,
          { occurredAt: context.occurredAt, causationId: context.commandId },
          OrchestrationEventType.InstanceSuperseded,
          {},
          1,
        ),
      ]);
    return false;
  }

  async isCausalRepeat(
    workflowInstanceId: WorkflowInstanceId,
    triggerId: string,
    causalCycleId: string | undefined,
    requestId?: string,
  ) {
    const parent = await this.repository.loadRequired(workflowInstanceId);
    return (await this.advance.listAll()).some(
      (view) =>
        view.orchestrationGroupId === parent.view.orchestrationGroupId &&
        view.parentWorkflowInstanceId !== undefined &&
        view.requestId !== requestId &&
        (view.triggerId === triggerId ||
          (causalCycleId !== undefined && view.causalCycleId === causalCycleId)),
    );
  }

  async getPrimaryWorkflowInstanceId(workItemId: WorkItemId) {
    return this.claims.primaryWorkflowInstanceId(workItemId);
  }

  private async complete(child: WorkflowInstanceView, context: CommandContext): Promise<void> {
    const metadata = childMetadata(child);
    if (child.watchId === undefined) throw new Error('Child workflow is missing watch provenance');
    const childLoaded = await this.repository.loadRequired(child.workflowInstanceId);
    if (!childLoaded.view.childCompletionRecorded)
      await this.repository.append(child.workflowInstanceId, childLoaded.sequence, [
        this.coordinationEvent(child, context, OrchestrationEventType.ChildCompleted, metadata, 1),
      ]);
    const parent = await this.repository.loadRequired(metadata.parentWorkflowInstanceId);
    if (parent.view.acceptedChildCompletionIds.includes(child.workflowInstanceId)) return;
    const signal: ChildCompletionSignal = {
      kind: signalName(OrchestrationEventType.ChildCompleted),
      actorId: 'orchestration',
      actorDecision: { authorized: true, evidenceId: child.workflowInstanceId },
      providerEventId: child.workflowInstanceId,
      authority: { kind: ApprovalAuthorityKind.Watch, watch: watchId(child.watchId) },
      childWorkflowInstanceId: child.workflowInstanceId,
      requestId: metadata.requestId,
    };
    const definition = await this.workflows.definitionForOperation(
      parent.view,
      parent.sequence,
      context,
    );
    if (definition === null) return;
    const decision = decideSignal(definition, parent.view, {
      signal,
      occurredAt: context.occurredAt,
      causationId: context.commandId,
    });
    if (decision.kind === 'ignored') return;
    await this.repository.append(parent.view.workflowInstanceId, parent.sequence, [
      ...decision.events,
      this.coordinationEvent(
        parent.view,
        context,
        OrchestrationEventType.ChildCompletionConsumed,
        metadata,
        2,
      ),
    ]);
  }

  private coordinationEvent<Type extends keyof ChildCoordinationEventPayloads>(
    state: WorkflowInstanceView,
    context: CommandContext,
    eventType: Type,
    payload: ChildCoordinationEventPayloads[Type],
    ordinal: number,
  ) {
    return coordinationDraft(
      {
        workflowInstanceId: state.workflowInstanceId,
        eventIdPrefix: context.commandId,
        occurredAt: context.occurredAt,
        correlationId: state.orchestrationGroupId,
        causationId: context.commandId,
      },
      eventType,
      payload,
      ordinal,
    );
  }
}

function parentWaitsForWatch(parent: WorkflowInstanceView, watchId: string): boolean {
  if (parent.status !== WorkflowStatus.Waiting) return false;
  const watchIds = watchIdsFor(parent.waitingFor);
  return watchIds.includes(watchId);
}

function watchIdsFor(wait: SignalExpectationView | undefined): readonly string[] {
  if (wait?.from === undefined) return [];
  return (wait.from ?? []).flatMap((authority) =>
    authority.kind === ApprovalAuthorityKind.Watch ? [authority.watch] : [],
  );
}
