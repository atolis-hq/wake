import { BuiltInActivityName } from '../../activities/index.js';
import { ExecutionEventType, type RunRepository } from '../../execution/index.js';
import {
  EventActorKind,
  EventSourceKind,
  createEventDraft,
  type CheckpointStore,
  type EventJournal,
} from '../../kernel/index.js';
import { OrchestrationEventType, OrchestrationStreamKind } from '../../orchestration/index.js';
import type { OrchestrationService } from '../../orchestration/index.js';
import type { ResourceService } from '../../resources/index.js';
import { ResourceCorrelationRole, resourceStream } from '../../resources/index.js';
import { DeliveryIntentEventType } from '../delivery/contracts/intents.js';
import { projectTerminalAgentRunReport, type TerminalRun } from './terminal-agent-run-report.js';

/** Projects terminal agent runs into one durable outbound intent per primary resource. */
export class AgentRunPublicationReactor {
  constructor(
    private readonly dependencies: {
      readonly journal: EventJournal;
      readonly checkpoints: CheckpointStore;
      readonly runs: RunRepository;
      readonly resources: Pick<ResourceService, 'correlationsForWork'>;
      readonly orchestration: Pick<OrchestrationService, 'listAll'>;
    },
  ) {}

  async runOnce(limit = 100): Promise<number> {
    const consumer = 'reactor:agent-run-publication';
    const events = await this.dependencies.journal.readAll(
      await this.dependencies.checkpoints.load(consumer),
      limit,
    );
    for (const event of events) {
      if (
        event.eventType === ExecutionEventType.RunSucceeded ||
        event.eventType === ExecutionEventType.RunFailed
      )
        await this.publish(event.stream.id, event.recordedAt, event.eventId, event.correlationId);
      await this.dependencies.checkpoints.save(consumer, event.globalPosition);
    }
    return events.length;
  }

  private async publish(
    id: string,
    occurredAt: string,
    causationId: string,
    correlationId: string,
  ) {
    const run = (await this.dependencies.runs.load(id as never)).view;
    if (run?.activity !== BuiltInActivityName.Agent || run.finishedAt === undefined) return;
    const workflow = (await this.dependencies.orchestration.listAll()).find(
      (value) => value.workflowInstanceId === run.workflowInstanceId,
    );
    if (workflow === undefined) return;
    const primary = (
      await this.dependencies.resources.correlationsForWork(workflow.workItemId)
    ).find((value) => value.role === ResourceCorrelationRole.Primary);
    if (primary === undefined) return;
    const stage = await this.stageForActivation(workflow.workflowInstanceId, run.activationId);
    const report = projectTerminalAgentRunReport(
      reportInput(run, stage, workflow.waitingFor?.signalKind === 'approved'),
    );
    if (report === null) return;
    const stream = resourceStream(primary.resourceId);
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
            resourceId: primary.resourceId,
            report,
          },
        }),
      ]);
    } catch {
      /* idempotency is the deterministic run event id */
    }
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
  awaitingApproval: boolean,
): Parameters<typeof projectTerminalAgentRunReport>[0] {
  return {
    run,
    ...(stage === undefined ? {} : { stage }),
    ...(awaitingApproval ? { awaitingApproval: true } : {}),
  };
}
