import { BuiltInActivityName } from '../../activities/index.js';
import {
  conversationIdForWorkItem,
  ConversationOriginKind,
  type ConversationService,
} from '../../conversations/index.js';
import { RunStatus, type RunRepository } from '../../execution/index.js';
import {
  createEventDraft,
  EventActorKind,
  EventSourceKind,
  type CheckpointStore,
  type EventJournal,
} from '../../kernel/index.js';
import {
  ApprovalAuthorityKind,
  isApprovalAwaitingSignalKind,
  OrchestrationEventType,
  OrchestrationStreamKind,
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
import { DeliveryIntentEventType } from '../delivery/contracts/intents.js';
import {
  defaultReplyPublication,
  selectReplyTarget,
} from '../github/application/reply-target-selector.js';
import { projectTerminalAgentRunReport, type TerminalRun } from './terminal-agent-run-report.js';

/** Projects terminal agent runs into one durable outbound intent per configured resource. */
export class AgentRunPublicationReactor {
  constructor(
    private readonly dependencies: {
      readonly journal: EventJournal;
      readonly checkpoints: CheckpointStore;
      readonly runs: RunRepository;
      readonly resources: Pick<ResourceService, 'correlationsForWork' | 'get'>;
      readonly orchestration: Pick<OrchestrationService, 'listAll'>;
      readonly conversations?: Pick<ConversationService, 'createForWorkItem' | 'record'>;
      readonly replies?: ReplyPublicationConfig | undefined;
    },
  ) {}

  async runOnce(limit = 100): Promise<number> {
    const consumer = 'reactor:agent-run-publication';
    const events = await this.dependencies.journal.readAll(
      await this.dependencies.checkpoints.load(consumer),
      limit,
    );
    for (const event of events) {
      if (event.eventType === OrchestrationEventType.ActivityOutcomeAccepted)
        await this.publishAcceptedOutcome(
          event.stream.id,
          (event.payload as { readonly activationId: string }).activationId,
          event.recordedAt,
          event.eventId,
          event.correlationId,
        );
      if (event.eventType === OrchestrationEventType.ActivityExecutionFailed)
        await this.publish(
          (event.payload as { readonly runId: string }).runId,
          event.recordedAt,
          event.eventId,
          event.correlationId,
        );
      await this.dependencies.checkpoints.save(consumer, event.globalPosition);
    }
    return events.length;
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
      await this.dependencies.journal.append(stream, sequence, [
        createEventDraft({
          eventId: `agent-run:${run.runId}`,
          eventType: DeliveryIntentEventType.AgentRunPublishRequested,
          occurredAt,
          correlationId: correlationId as never,
          causationId: causationId as never,
          actor: { kind: EventActorKind.Integration, id: 'agent-run-publication' },
          source: { kind: EventSourceKind.Internal, id: 'agent-run-publication' },
          stream,
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
    const request = events.findIndex(
      (event) =>
        event.eventType === OrchestrationEventType.ActivityRequested &&
        (event.payload as { readonly activationId: string }).activationId === activationId,
    );
    for (let index = request - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.eventType === OrchestrationEventType.StageEntered)
        return (event.payload as { readonly stage: string }).stage;
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
