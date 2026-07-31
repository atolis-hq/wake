import { EventSourceKind, createEventDraft, type CommandContext } from '../../kernel/index.js';
import type { ActivationId } from '../../activities/index.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import type { SupplementalActivityRequest } from '../contracts/events.js';
import {
  commandName,
  workflowInstanceId,
  type SignalName,
  type WorkflowInstanceId,
} from '../contracts/identifiers.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { workflowInstanceStream } from '../contracts/streams.js';
import { requestSupplementalActivity as decideSupplementalActivity } from '../domain/interpreter.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { StartWorkflow } from './start-workflow.js';

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
    const configured = this.workflows.definition(loaded.view.workflowName).commands[
      commandName(request.command)
    ];
    if (configured === undefined)
      throw new Error(`Unknown supplemental command: ${request.command}`);
    if (!configured.allowedActors.includes(context.actor.kind))
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

  async listWatchMatches(eventType: string) {
    return (await this.listAll()).flatMap((parent) => {
      const definition = this.workflows.definition(parent.workflowName);
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
}
