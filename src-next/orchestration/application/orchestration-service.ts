import { WorkflowInstanceKind, WorkflowStatus } from '../contracts/vocabulary.js';
import { EventSourceKind } from '../../kernel/index.js';
import type { ActivationId, ActivityOutcome } from '../../activities/index.js';
import { createEventDraft, type CommandContext, type EventJournal } from '../../kernel/index.js';
import { WorkStatus, type WorkItemId, type WorkService } from '../../work/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import type { GroupBudgetExhaustedView, WorkflowInstanceView } from '../contracts/views.js';
import type { StartWorkflowInstance } from '../contracts/commands.js';
import type {
  ChildCoordinationEventPayloads,
  ChildWorkflowRequest,
  ChildCompletionSignal,
  OrchestrationSignal,
  SignalExpectation,
  SupplementalActivityRequest,
} from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { orchestrationActivityOutcome } from '../contracts/activity-outcome.js';
import {
  acceptActivityOutcome,
  acceptSignal,
  requestSupplementalActivity,
  startInstance,
  waitForSignal,
} from '../domain/interpreter.js';
import { stateDraft } from '../domain/decision-events.js';
import {
  childMetadata,
  childRequestId,
  coordinationMetadata,
  validateChildProvenance,
} from '../domain/child-coordination.js';
import { coordinationDraft } from '../domain/coordination-events.js';
import {
  commandName,
  signalName,
  workflowInstanceId as parseWorkflowInstanceId,
  type SignalName,
  type WorkflowInstanceId,
  type WorkflowName,
} from '../contracts/identifiers.js';
import { childOrchestrationGroupStream, workflowInstanceStream } from '../contracts/streams.js';
import { CoordinationClaims } from './coordination-claims.js';
import { GroupBudgetRecorder } from './group-budget-recorder.js';
import { OrchestrationRepository } from './orchestration-repository.js';

export class OrchestrationService {
  private readonly repository: OrchestrationRepository;
  private readonly claims: CoordinationClaims;
  private readonly groupBudgets: GroupBudgetRecorder;

  constructor(
    journal: EventJournal,
    private readonly work: WorkService,
    private readonly definitions: Readonly<Record<string, CompiledWorkflow>>,
  ) {
    this.repository = new OrchestrationRepository(journal);
    this.claims = new CoordinationClaims(journal);
    this.groupBudgets = new GroupBudgetRecorder(journal);
  }

  async start(command: StartWorkflowInstance, context: CommandContext) {
    const item = await this.work.get(command.workItemId);
    if (item === null || item.state !== WorkStatus.Open)
      throw new Error('WorkItem must exist and be open');
    const definition = this.definition(command.workflowName);
    const existing = await this.repository.load(command.workflowInstanceId);
    if (existing.view !== null) return existing.view;
    const startKind = validateChildProvenance(command);
    if (startKind === WorkflowInstanceKind.Primary) {
      await this.claims.claimPrimary(command.workItemId, command.workflowInstanceId, context);
    } else {
      const parent = await this.loadRequired(command.parentWorkflowInstanceId!);
      if (
        parent.view.workItemId !== command.workItemId ||
        parent.view.orchestrationGroupId !== command.orchestrationGroupId
      )
        throw new Error('Child workflow must share its parent WorkItem and orchestration group');
    }
    const decision = startInstance({
      ...command,
      definition,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
    });
    if (decision.kind === 'append')
      await this.repository.append(command.workflowInstanceId, 0, decision.events);
    return (await this.repository.load(command.workflowInstanceId)).view!;
  }

  async requestChild(
    request: ChildWorkflowRequest & { readonly maxPerGroup: number },
    context: CommandContext,
  ): Promise<WorkflowInstanceView | GroupBudgetExhaustedView> {
    const parent = await this.loadRequired(request.parentWorkflowInstanceId);
    const workflowInstanceId = childRequestId(request);
    if (request.requestId !== workflowInstanceId)
      throw new Error('Child request id must be stable for its parent, watch, and trigger');
    const existing = await this.repository.load(workflowInstanceId);
    if (existing.view !== null) return existing.view;
    const groupStream = childOrchestrationGroupStream(
      parent.view.orchestrationGroupId,
      request.watchId,
    );
    const metadata = coordinationMetadata(parent.view, request);
    if (!(await this.claims.claimWithinBudget(groupStream, request, context))) {
      await this.groupBudgets.record(parent.view, metadata, request.maxPerGroup, context);
      return { kind: 'group-budget-exhausted', requestId: request.requestId };
    }
    return this.start(
      {
        workflowInstanceId,
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
    const loaded = await this.loadRequired(request.parentWorkflowInstanceId);
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
    return (await this.repository.load(loaded.view.workflowInstanceId)).view!;
  }

  async acceptOutcome(
    command: {
      workflowInstanceId: WorkflowInstanceId;
      activationId: ActivationId;
      outcome: ActivityOutcome;
    },
    context: CommandContext,
  ) {
    const loaded = await this.loadRequired(command.workflowInstanceId);
    const decision = acceptActivityOutcome(this.definition(loaded.view.workflowName), loaded.view, {
      ...command,
      outcome: orchestrationActivityOutcome(command.outcome),
      occurredAt: context.occurredAt,
      causationId: context.commandId,
    });
    await this.appendDecision(command.workflowInstanceId, loaded.sequence, decision);
    await this.reconcileChildCompletions(context);
    return (await this.repository.load(command.workflowInstanceId)).view!;
  }

  async waitForSignal(
    workflowInstanceId: WorkflowInstanceId,
    expectation: SignalExpectation,
    context: CommandContext,
  ) {
    const loaded = await this.loadRequired(workflowInstanceId);
    const decision = waitForSignal(loaded.view, expectation, {
      occurredAt: context.occurredAt,
      causationId: context.commandId,
    });
    if (decision.kind === 'ignored') throw new Error(decision.reason);
    await this.repository.append(workflowInstanceId, loaded.sequence, decision.events);
    return (await this.repository.load(workflowInstanceId)).view!;
  }

  async acceptSignal(
    workflowInstanceId: WorkflowInstanceId,
    signal: OrchestrationSignal,
    context: CommandContext,
  ) {
    const loaded = await this.loadRequired(workflowInstanceId);
    const decision = acceptSignal(this.definition(loaded.view.workflowName), loaded.view, {
      signal,
      occurredAt: context.occurredAt,
      causationId: context.commandId,
    });
    await this.appendDecision(workflowInstanceId, loaded.sequence, decision);
    return (await this.repository.load(workflowInstanceId)).view!;
  }

  async requestSupplementalActivity(
    workflowInstanceId: WorkflowInstanceId,
    request: SupplementalActivityRequest,
    context: CommandContext,
  ) {
    const loaded = await this.loadRequired(workflowInstanceId);
    const configured = this.definition(loaded.view.workflowName).commands[
      commandName(request.command)
    ];
    if (configured === undefined)
      throw new Error(`Unknown supplemental command: ${request.command}`);
    if (!configured.allowedActors.includes(context.actor.kind))
      throw new Error(`Actor kind ${context.actor.kind} is not authorised for ${request.command}`);
    const decision = requestSupplementalActivity(
      loaded.view,
      {
        activity: configured.activity,
        input: configured.with,
        requestedBy: context.actor.id,
      },
      { occurredAt: context.occurredAt, causationId: context.commandId },
    );
    if (decision.kind === 'ignored') throw new Error(decision.reason);
    await this.repository.append(workflowInstanceId, loaded.sequence, decision.events);
    return (await this.repository.load(workflowInstanceId)).view!;
  }

  async markActivationStarted(
    workflowInstanceId: WorkflowInstanceId,
    activationId: ActivationId,
    context: CommandContext,
  ) {
    const loaded = await this.repository.load(workflowInstanceId);
    if (loaded.view?.pendingActivation?.activationId !== activationId) return loaded.view;
    const event = createEventDraft({
      eventId: `${context.commandId}:${OrchestrationEventType.ActivityStarted}`,
      eventType: OrchestrationEventType.ActivityStarted,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
      actor: context.actor,
      source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
      stream: workflowInstanceStream(parseWorkflowInstanceId(workflowInstanceId)),
      payload: { activationId },
    });
    await this.repository.append(workflowInstanceId, loaded.sequence, [event]);
    return (await this.repository.load(workflowInstanceId)).view;
  }

  async get(id: WorkflowInstanceId) {
    return (await this.repository.load(id)).view;
  }

  async getPrimaryWorkflowInstanceId(workItemId: WorkItemId) {
    return this.claims.primaryWorkflowInstanceId(workItemId);
  }

  async listPendingActivations(workItemId?: string) {
    return (await this.repository.list())
      .filter(
        (view) =>
          view !== null &&
          view.status === WorkflowStatus.Active &&
          view.pendingActivation !== undefined &&
          (workItemId === undefined || view.workItemId === workItemId),
      )
      .map((view) => ({ workflow: view!, activation: view!.pendingActivation! }));
  }

  async listWaiting(signalKind?: SignalName) {
    return (await this.repository.list()).filter(
      (view) =>
        view?.status === WorkflowStatus.Waiting &&
        (signalKind === undefined || view.waitingFor?.signalKind === signalKind),
    );
  }

  async listAll() {
    return (await this.repository.list()).filter((view) => view !== null);
  }

  async reconcileChildCompletions(context: CommandContext): Promise<void> {
    for (const child of await this.listAll()) {
      if (child.parentWorkflowInstanceId !== undefined && child.status === WorkflowStatus.Completed)
        await this.completeChild(child, {
          ...context,
          commandId: `${context.commandId}:child:${child.workflowInstanceId}`,
        });
    }
  }

  async isCausalRepeat(
    workflowInstanceId: WorkflowInstanceId,
    triggerId: string,
    causalCycleId: string | undefined,
    requestId?: string,
  ) {
    const parent = await this.loadRequired(workflowInstanceId);
    return (await this.listAll()).some(
      (view) =>
        view.orchestrationGroupId === parent.view.orchestrationGroupId &&
        view.parentWorkflowInstanceId !== undefined &&
        view.requestId !== requestId &&
        (view.triggerId === triggerId ||
          (causalCycleId !== undefined && view.causalCycleId === causalCycleId)),
    );
  }

  async listWatchMatches(eventType: string) {
    return (await this.listAll()).flatMap((parent) => {
      const definition = this.definition(parent.workflowName);
      return definition.watches
        .filter(
          (watch) =>
            watch.on?.events.includes(eventType) === true &&
            watch.while.stages.includes(parent.currentStage) &&
            watch.while.statuses.some((status) => status === parent.status),
        )
        .map((watch) => ({ parent, watch }));
    });
  }

  private definition(name: WorkflowName): CompiledWorkflow {
    const definition = this.definitions[name];
    if (definition === undefined) throw new Error(`Unknown workflow: ${name}`);
    return definition;
  }

  private async loadRequired(id: WorkflowInstanceId) {
    const loaded = await this.repository.load(id);
    if (loaded.view === null) throw new Error('WorkflowInstance does not exist');
    return { sequence: loaded.sequence, view: loaded.view };
  }

  private async appendDecision(
    id: WorkflowInstanceId,
    sequence: number,
    decision: ReturnType<typeof acceptActivityOutcome>,
  ): Promise<void> {
    if (decision.kind === 'append') await this.repository.append(id, sequence, decision.events);
  }

  private async completeChild(child: WorkflowInstanceView, context: CommandContext): Promise<void> {
    const metadata = childMetadata(child);
    const childLoaded = await this.loadRequired(child.workflowInstanceId);
    if (!childLoaded.view.childCompletionRecorded)
      await this.repository.append(child.workflowInstanceId, childLoaded.sequence, [
        this.coordinationEvent(child, context, OrchestrationEventType.ChildCompleted, metadata, 1),
      ]);
    const parent = await this.loadRequired(metadata.parentWorkflowInstanceId);
    if (parent.view.acceptedChildCompletionIds.includes(child.workflowInstanceId)) return;
    const signal: ChildCompletionSignal = {
      kind: signalName(OrchestrationEventType.ChildCompleted),
      actorId: 'orchestration',
      actorDecision: { authorized: true, evidenceId: child.workflowInstanceId },
      providerEventId: child.workflowInstanceId,
      childWorkflowInstanceId: child.workflowInstanceId,
      requestId: metadata.requestId,
    };
    const decision = acceptSignal(this.definition(parent.view.workflowName), parent.view, {
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

export const createOrchestrationService = (
  journal: EventJournal,
  work: WorkService,
  definitions: Readonly<Record<string, CompiledWorkflow>>,
) => new OrchestrationService(journal, work, definitions);
