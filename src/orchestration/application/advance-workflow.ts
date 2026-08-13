import type { ActivationId } from '../../activities/index.js';
import { EventSourceKind, createEventDraft, type CommandContext } from '../../kernel/index.js';
import type { SupplementalActivityRequest } from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import {
  commandName,
  workflowInstanceId,
  type SignalName,
  type WorkflowInstanceId,
} from '../contracts/identifiers.js';
import { workflowInstanceStream } from '../contracts/streams.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import {
  requestOperatorRetry as decideOperatorRetry,
  requestSupplementalActivity as decideSupplementalActivity,
} from '../domain/interpreter.js';
import { isAuthorisedActor } from '../domain/supplemental-policy.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { StartWorkflow } from './start-workflow.js';

export class OperatorRetryIneligibleError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'OperatorRetryIneligibleError';
  }
}

export class AdvanceWorkflow {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly workflows: StartWorkflow,
  ) {}

  async requestSupplementalActivity(
    id: WorkflowInstanceId,
    request: SupplementalActivityRequest,
    context: CommandContext,
  ) {
    const loaded = await this.repository.loadRequired(id);
    const definition = await this.workflows.definitionForOperation(
      loaded.view,
      loaded.sequence,
      context,
    );
    if (definition === null) return (await this.repository.loadRequired(id)).view;
    const configured = definition.commands[commandName(request.command)];
    if (configured === undefined)
      throw new Error(`Unknown supplemental command: ${request.command}`);
    if (!isAuthorisedActor(configured.allowedActors, context.actor.kind))
      throw new Error(`Actor kind ${context.actor.kind} is not authorised for ${request.command}`);
    const decision = decideSupplementalActivity(
      loaded.view,
      {
        activity: configured.activity,
        input: configured.with,
        requestedBy: context.actor.id,
      },
      { occurredAt: context.occurredAt, causationId: context.commandId },
    );
    if (decision.kind === 'ignored') throw new Error(decision.reason);
    await this.repository.append(id, loaded.sequence, decision.events);
    return (await this.repository.loadRequired(id)).view;
  }

  async markActivationStarted(
    id: WorkflowInstanceId,
    activationId: ActivationId,
    context: CommandContext,
  ) {
    const loaded = await this.repository.load(id);
    if (loaded.view?.pendingActivation?.activationId !== activationId) return loaded.view;
    const event = createEventDraft({
      eventId: `${context.commandId}:${OrchestrationEventType.ActivityStarted}`,
      eventType: OrchestrationEventType.ActivityStarted,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
      actor: context.actor,
      source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
      stream: workflowInstanceStream(workflowInstanceId(id)),
      payload: { activationId },
    });
    await this.repository.append(id, loaded.sequence, [event]);
    return (await this.repository.load(id)).view;
  }

  async block(id: WorkflowInstanceId, reason: string, context: CommandContext) {
    const loaded = await this.repository.load(id);
    if (loaded.view === null || loaded.view.status === WorkflowStatus.Blocked) return loaded.view;
    const event = createEventDraft({
      eventId: `${context.commandId}:${OrchestrationEventType.InstanceBlocked}`,
      eventType: OrchestrationEventType.InstanceBlocked,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
      actor: context.actor,
      source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
      stream: workflowInstanceStream(id),
      payload: { reason },
    });
    await this.repository.append(id, loaded.sequence, [event]);
    return (await this.repository.load(id)).view;
  }

  async resolveExecutionFailure(
    id: WorkflowInstanceId,
    input: { readonly activationId: ActivationId; readonly runId: string; readonly reason: string },
    context: CommandContext,
  ) {
    const loaded = await this.repository.load(id);
    if (
      loaded.view === null ||
      loaded.view.status === WorkflowStatus.Blocked ||
      loaded.view.pendingActivation?.activationId !== input.activationId ||
      loaded.view.acceptedOutcomes.includes(input.activationId)
    )
      return loaded.view;
    const stream = workflowInstanceStream(id);
    await this.repository.append(id, loaded.sequence, [
      createEventDraft({
        eventId: `${context.commandId}:${OrchestrationEventType.ActivityExecutionFailed}`,
        eventType: OrchestrationEventType.ActivityExecutionFailed,
        occurredAt: context.occurredAt,
        correlationId: context.correlationId,
        causationId: context.commandId,
        actor: context.actor,
        source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
        stream,
        payload: input,
      }),
      createEventDraft({
        eventId: `${context.commandId}:${OrchestrationEventType.InstanceBlocked}`,
        eventType: OrchestrationEventType.InstanceBlocked,
        occurredAt: context.occurredAt,
        correlationId: context.correlationId,
        causationId: context.commandId,
        actor: context.actor,
        source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
        stream,
        payload: { reason: input.reason },
      }),
    ]);
    return (await this.repository.load(id)).view;
  }

  async retryBlockedFailedStage(id: WorkflowInstanceId, context: CommandContext) {
    const loaded = await this.repository.load(id);
    if (loaded.view === null)
      throw new OperatorRetryIneligibleError('WorkflowInstance does not exist');
    if (loaded.view.operatorRetryCommandIds.includes(context.commandId)) return loaded.view;
    const definition = await this.workflows.definitionForOperation(
      loaded.view,
      loaded.sequence,
      context,
    );
    if (definition === null) return (await this.repository.loadRequired(id)).view;
    const decision = decideOperatorRetry(definition, loaded.view, {
      commandId: context.commandId,
      occurredAt: context.occurredAt,
      causationId: context.commandId,
    });
    if (decision.kind === 'ignored') throw new OperatorRetryIneligibleError(decision.reason);
    try {
      await this.repository.append(id, loaded.sequence, decision.events);
    } catch (error) {
      const reloaded = await this.repository.loadRequired(id);
      if (reloaded.view.operatorRetryCommandIds.includes(context.commandId)) return reloaded.view;
      throw error;
    }
    return (await this.repository.loadRequired(id)).view;
  }

  async get(id: WorkflowInstanceId) {
    return (await this.repository.load(id)).view;
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

  async listWatchMatches(eventType: string, context?: CommandContext) {
    const matches = await Promise.all(
      (await this.listAll()).map(async (parent) => {
        const loaded = await this.repository.loadRequired(parent.workflowInstanceId);
        const definition =
          context === undefined
            ? await this.workflows.definitionFor(loaded.view)
            : await this.workflows.definitionForOperation(loaded.view, loaded.sequence, context);
        if (definition === null) return [];
        return definition.watches
          .filter(
            (watch) =>
              watch.on?.events.includes(eventType) === true &&
              watch.while.stages.includes(parent.currentStage) &&
              watch.while.statuses.some((status) => status === parent.status),
          )
          .map((watch) => ({ parent, watch }));
      }),
    );
    return matches.flat();
  }
}
