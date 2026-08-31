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
  ApprovalAuthorityKind,
  isApprovalAwaitingSignalKind,
  OrchestrationEventType,
  OrchestrationStreamKind,
  selectWorkflowOrchestrationEvent,
  WatchGateVerdictSignal,
  type OrchestrationService,
  type WorkflowInstanceView,
} from '../../orchestration/index.js';
import type { ResourceService } from '../../resources/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationRole,
  resourceStream,
  type ResourceCorrelationView,
} from '../../resources/index.js';
import { ReplyTarget, type ReplyPublicationConfig } from '../contracts/reply-routing.js';
import { createDeliveryIntentEventData } from '../delivery/contracts/event-factory.js';
import { DeliveryIntentEventType } from '../delivery/contracts/intents.js';
import {
  defaultReplyPublication,
  selectReplyTarget,
} from '../github/application/reply-target-selector.js';
import { projectTerminalAgentRunReport, type TerminalRun } from './terminal-agent-run-report.js';

/** Projects terminal agent runs into one durable outbound intent per configured resource. */
export class AgentRunPublicationReactor {
  readonly processor: EventProcessor;

  constructor(
    private readonly dependencies: {
      readonly journal: EventJournal;
      readonly runs: RunRepository;
      readonly resources: Pick<ResourceService, 'correlationsForWork' | 'get'>;
      readonly orchestration: Pick<OrchestrationService, 'listAll'>;
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
          outcome?.event.eventType === OrchestrationEventType.ActivityExecutionFailed
          ? outcome
          : null;
      },
      handle: async (outcome) => this.react(outcome),
    });
  }

  async react(
    outcome: NonNullable<ReturnType<typeof selectWorkflowOrchestrationEvent>>,
  ): Promise<void> {
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
    const report = projectTerminalAgentRunReport(reportInput(run, stage, workflow, allWorkflows));
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
    const resource = await this.resourceForTarget(workflow.workItemId, target);
    if (resource === undefined) return;
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
            report,
          },
        }),
      ]);
    } catch {
      /* idempotency is the deterministic run event id */
    }
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

  private async resourceForTarget(
    workItemId: WorkflowInstanceView['workItemId'],
    target: Exclude<ReplyPublicationConfig['default'], typeof ReplyTarget.None>,
  ): Promise<ResourceCorrelationView | undefined> {
    const correlations = await this.dependencies.resources.correlationsForWork(workItemId);
    const primary = () =>
      correlations.find((value) => value.role === ResourceCorrelationRole.Primary);
    if (target === ReplyTarget.Primary) return primary();
    const kind =
      target === ReplyTarget.Issue ? BuiltInResourceKind.Issue : BuiltInResourceKind.PullRequest;
    for (const correlation of correlations) {
      const resource = await this.dependencies.resources.get(correlation.resourceId);
      if (resource?.kind === kind) return correlation;
    }
    return primary();
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

function reportInput(
  run: TerminalRun,
  stage: string | undefined,
  workflow: WorkflowInstanceView,
  allWorkflows: readonly WorkflowInstanceView[],
): Parameters<typeof projectTerminalAgentRunReport>[0] {
  const watchGateVerdict = watchGateVerdictFor(run, workflow, allWorkflows);
  const isWaiting =
    workflow.waitingFor !== undefined &&
    isApprovalAwaitingSignalKind(workflow.waitingFor.signalKind);
  return {
    run,
    ...(stage === undefined ? {} : { stage }),
    ...(isWaiting ? { awaitingApproval: true } : {}),
    ...(watchGateVerdict === undefined ? {} : { watchGateVerdict }),
  };
}

function watchGateVerdictFor(
  run: TerminalRun,
  workflow: WorkflowInstanceView,
  allWorkflows: readonly WorkflowInstanceView[],
): { readonly runId: string } | undefined {
  if (run.agent?.outcome !== 'DONE' && run.agent?.outcome !== 'REJECTED') return undefined;
  if (workflow.parentWorkflowInstanceId === undefined || workflow.watchId === undefined)
    return undefined;
  const parent = allWorkflows.find(
    (value) => value.workflowInstanceId === workflow.parentWorkflowInstanceId,
  );
  if (parent?.waitingFor?.signalKind !== WatchGateVerdictSignal) return undefined;
  const namesThisWatch = parent.waitingFor.from?.some(
    (entry) => entry.kind === ApprovalAuthorityKind.Watch && entry.watch === workflow.watchId,
  );
  return namesThisWatch === true ? { runId: run.runId } : undefined;
}
