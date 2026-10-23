import {
  defineEventProcessor,
  EventActorKind,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  EventSourceKind,
  type EventJournal,
  type EventProcessor,
} from '@atolis-hq/eventing';
import { BuiltInActivityName } from '../../activities/index.js';
import {
  conversationIdForWorkItem,
  ConversationOriginKind,
  type ConversationService,
} from '../../conversations/index.js';
import { RunStatus, type RunRepository } from '../../execution/index.js';
import {
  OrchestrationEventType,
  OrchestrationStreamKind,
  selectWorkflowOrchestrationEvent,
  type OrchestrationService,
  type WorkflowInstanceView,
} from '../../orchestration/index.js';
import type { ResourceService } from '../../resources/index.js';
import { resourceStream } from '../../resources/index.js';
import type { WorkService } from '../../work/index.js';
import { ReplyTarget, type ReplyPublicationConfig } from '../contracts/reply-routing.js';
import { createDeliveryIntentEventData } from '../delivery/contracts/event-factory.js';
import { DeliveryIntentEventType } from '../delivery/contracts/intents.js';
import {
  defaultReplyPublication,
  selectReplyTarget,
} from '../github/application/reply-target-selector.js';
import { projectTerminalAgentRunReport } from './terminal-agent-run-report.js';

import { agentRunReportInput, mergeWaitComment } from './agent-run-publication-report.js';
import { labelledForSharedResource, resourceForTarget } from './agent-run-publication-target.js';

/** Projects terminal agent runs into one durable outbound intent per configured resource. */
export class AgentRunPublicationReactor {
  readonly processor: EventProcessor;

  constructor(
    private readonly dependencies: {
      readonly journal: EventJournal;
      readonly runs: RunRepository;
      readonly resources: Pick<ResourceService, 'correlationsForWork' | 'get'>;
      readonly orchestration: Pick<OrchestrationService, 'listAll'>;
      readonly work?: Pick<WorkService, 'get'> | undefined;
      readonly conversations?: Pick<ConversationService, 'createForWorkItem' | 'record'>;
      readonly replies?: ReplyPublicationConfig | undefined;
    },
  ) {
    this.processor = defineEventProcessor({
      consumer: 'reactor:agent-run-publication',
      name: 'agent-run-publication',
      owner: 'integrations',
      category: EventProcessorCategory.Reactor,
      replayPolicy: EventProcessorReplayPolicy.Idempotent,
      select(event) {
        const outcome = selectWorkflowOrchestrationEvent(event);
        return outcome?.event.eventType === OrchestrationEventType.ActivityOutcomeAccepted ||
          outcome?.event.eventType === OrchestrationEventType.ActivityExecutionFailed ||
          outcome?.event.eventType === OrchestrationEventType.SignalWaitStarted
          ? outcome
          : null;
      },
      handle: async (outcome) => this.react(outcome),
    });
  }

  async react(
    outcome: NonNullable<ReturnType<typeof selectWorkflowOrchestrationEvent>>,
  ): Promise<void> {
    if (outcome.event.eventType === OrchestrationEventType.SignalWaitStarted) {
      await this.publishMergeWait(outcome);
      return;
    }
    if (outcome.event.eventType === OrchestrationEventType.ActivityOutcomeAccepted) {
      await this.publishAcceptedOutcome(
        outcome.stream.id,
        outcome.event.payload.activationId,
        outcome.recordedAt,
        outcome.event.eventId,
        outcome.event.correlationId,
      );
      return;
    }
    if (outcome.event.eventType !== OrchestrationEventType.ActivityExecutionFailed) return;
    await this.publish(
      outcome.event.payload.runId,
      outcome.recordedAt,
      outcome.event.eventId,
      outcome.event.correlationId,
    );
  }

  private async publishAcceptedOutcome(
    workflowInstanceId: string,
    activationId: string,
    occurredAt: string,
    causationId: string,
    correlationId: string,
  ) {
    const run = (await this.dependencies.runs.list(activationId as never)).find(
      (candidate) =>
        candidate.workflowInstanceId === workflowInstanceId &&
        candidate.status === RunStatus.Succeeded &&
        candidate.activity === BuiltInActivityName.Agent,
    );
    if (run === undefined) return;
    await this.publish(run.runId, occurredAt, causationId, correlationId);
  }

  private async publish(
    id: string,
    occurredAt: string,
    causationId: string,
    correlationId: string,
  ) {
    const run = (await this.dependencies.runs.load(id as never)).view;
    if (run?.activity !== BuiltInActivityName.Agent || run.finishedAt === undefined) return;
    const allWorkflows = await this.dependencies.orchestration.listAll();
    const workflow = allWorkflows.find(
      (value) => value.workflowInstanceId === run.workflowInstanceId,
    );
    if (workflow === undefined) return;
    const stage = await this.stageForActivation(workflow.workflowInstanceId, run.activationId);
    const report = projectTerminalAgentRunReport(
      agentRunReportInput(run, stage, workflow, allWorkflows),
    );
    if (report === null) return;
    await this.recordConversationEntry(
      workflow.workItemId,
      run.runId,
      report.displayBody,
      stage,
      occurredAt,
      correlationId,
    );
    const replies = this.dependencies.replies ?? defaultReplyPublication;
    const target = selectReplyTarget(
      { stage, outcome: report.outcome },
      replies.rules,
      replies.default,
    );
    if (target === ReplyTarget.None) return;
    const resource = await resourceForTarget(
      this.dependencies.resources,
      workflow.workItemId,
      target,
    );
    if (resource === undefined) return;
    const published = await labelledForSharedResource(
      this.dependencies.work,
      workflow.workItemId,
      resource,
      report,
    );
    const stream = resourceStream(resource.resourceId);
    const sequence = (await this.dependencies.journal.readStream(stream)).length;
    try {
      await this.dependencies.journal.appendToStream(stream, sequence, [
        createDeliveryIntentEventData({
          eventId: `agent-run:${run.runId}`,
          eventType: DeliveryIntentEventType.AgentRunPublishRequested,
          occurredAt,
          correlationId: correlationId as never,
          causationId: causationId as never,
          actor: { kind: EventActorKind.Integration, id: 'agent-run-publication' },
          source: { kind: EventSourceKind.Internal, id: 'agent-run-publication' },
          payload: {
            workflowInstanceId: run.workflowInstanceId,
            activationId: run.activationId,
            resourceId: resource.resourceId,
            ...(this.dependencies.conversations === undefined
              ? {}
              : {
                  conversationId: conversationIdForWorkItem(workflow.workItemId),
                  conversationEntryId: `agent-run:${run.runId}`,
                }),
            report: published,
          },
        }),
      ]);
    } catch {
      /* idempotency is the deterministic run event id */
    }
  }

  private async publishMergeWait(
    event: NonNullable<ReturnType<typeof selectWorkflowOrchestrationEvent>>,
  ) {
    const workflow = (await this.dependencies.orchestration.listAll()).find(
      (view) => view.workflowInstanceId === event.stream.id,
    );
    const body = mergeWaitComment(workflow);
    if (workflow?.pendingActivation === undefined || body === undefined) return;
    // A replayed older wait event must not publish guidance for a newer wait.
    if (
      event.event.eventType === OrchestrationEventType.SignalWaitStarted &&
      event.event.payload.signalKind !== workflow.waitingFor?.signalKind
    )
      return;
    const replies = this.dependencies.replies ?? defaultReplyPublication;
    const target = selectReplyTarget(
      { stage: workflow.currentStage, outcome: 'DONE' },
      replies.rules,
      replies.default,
    );
    if (target === ReplyTarget.None) return;
    const resource = await resourceForTarget(
      this.dependencies.resources,
      workflow.workItemId,
      target,
    );
    if (resource === undefined) return;
    const stream = resourceStream(resource.resourceId);
    const facts = await this.dependencies.journal.readStream(stream);
    const eventId = `merge-wait:${event.event.eventId}`;
    if (facts.some((fact) => fact.event.eventId === eventId)) return;
    await this.dependencies.journal.appendToStream(stream, facts.length, [
      createDeliveryIntentEventData({
        eventId,
        eventType: DeliveryIntentEventType.ReplyPublishRequested,
        occurredAt: event.recordedAt,
        correlationId: event.event.correlationId,
        causationId: event.event.eventId,
        actor: { kind: EventActorKind.Integration, id: 'agent-run-publication' },
        source: { kind: EventSourceKind.Internal, id: 'agent-run-publication' },
        payload: {
          workflowInstanceId: workflow.workflowInstanceId,
          activationId: workflow.pendingActivation.activationId,
          resourceId: resource.resourceId,
          body,
          publicationOnly: true,
        },
      }),
    ]);
  }

  private async recordConversationEntry(
    workItemId: WorkflowInstanceView['workItemId'],
    runId: string,
    body: string,
    stage: string | undefined,
    occurredAt: string,
    correlationId: string,
  ) {
    const conversations = this.dependencies.conversations;
    if (conversations === undefined) return;
    const context = {
      commandId: `conversation:${runId}`,
      correlationId: correlationId as never,
      occurredAt,
      actor: { kind: EventActorKind.Agent, id: 'wake' },
    };
    await conversations.createForWorkItem(workItemId, context);
    await conversations.record(
      {
        conversationId: conversationIdForWorkItem(workItemId),
        entryId: `agent-run:${runId}`,
        body,
        origin: {
          kind: ConversationOriginKind.Agent,
          actorId: 'wake',
          runId,
          ...(stage === undefined ? {} : { stage }),
        },
      },
      { ...context, commandId: `agent-run:${runId}` },
    );
  }

  private async stageForActivation(
    workflowInstanceId: string,
    activationId: string,
  ): Promise<string | undefined> {
    const events = await this.dependencies.journal.readStream({
      kind: OrchestrationStreamKind.WorkflowInstance,
      id: workflowInstanceId,
    } as never);
    const orchestrationEvents = events
      .map(selectWorkflowOrchestrationEvent)
      .filter((event) => event !== null);
    const request = orchestrationEvents.findIndex(
      (event) =>
        event.event.eventType === OrchestrationEventType.ActivityRequested &&
        event.event.payload.activationId === activationId,
    );
    for (let index = request - 1; index >= 0; index -= 1) {
      const event = orchestrationEvents[index];
      if (event?.event.eventType === OrchestrationEventType.StageEntered)
        return event.event.payload.stage;
    }
    return undefined;
  }
}
