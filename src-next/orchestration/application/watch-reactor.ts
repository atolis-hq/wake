import { EventActorKind } from '../../kernel/index.js';
import {
  correlationId,
  type CheckpointStore,
  type CommandContext,
  type EventJournal,
} from '../../kernel/index.js';
import { type ChildWorkflowRequest, type OrchestrationEvent } from '../contracts/events.js';
import { selectOrchestrationEvent } from '../contracts/event-decoder.js';
import {
  workflowInstanceId,
  workflowName,
  type WorkflowInstanceId,
  type WorkflowName,
} from '../contracts/identifiers.js';

interface WatchMatch {
  readonly parent: { readonly workflowInstanceId: WorkflowInstanceId };
  readonly watch: {
    readonly id: string;
    readonly workflow: WorkflowName;
    readonly maxPerGroup: number;
  };
}

interface WatchOrchestrationPort {
  listWatchMatches(eventType: string): Promise<readonly WatchMatch[]>;
  requestChild(
    request: ChildWorkflowRequest & { readonly maxPerGroup: number },
    context: CommandContext,
  ): Promise<unknown>;
  rejectCausalActivation(request: ChildWorkflowRequest, context: CommandContext): Promise<unknown>;
  isCausalRepeat?(
    workflowInstanceId: string,
    eventId: string,
    causalCycleId: string | undefined,
    requestId: string,
  ): Promise<boolean>;
}

const checkpoint = 'reactor:orchestration.watch';
type PersistedEvent = Parameters<typeof selectOrchestrationEvent>[0];

export function createWatchReactor(
  orchestration: WatchOrchestrationPort,
  journal?: EventJournal,
  checkpoints?: CheckpointStore,
) {
  return {
    async react(event: PersistedEvent, context: CommandContext): Promise<void> {
      const causalCycle = orchestrationCausalCycleId(selectOrchestrationEvent(event));
      for (const match of await orchestration.listWatchMatches(event.eventType)) {
        const requestId = workflowInstanceId(
          `${match.parent.workflowInstanceId}:watch:${match.watch.id}:trigger:${event.eventId}`,
        );
        const request = {
          parentWorkflowInstanceId: match.parent.workflowInstanceId,
          watchId: match.watch.id,
          triggerId: event.eventId,
          workflowName: workflowName(match.watch.workflow),
          causalCycleId: causalCycle ?? requestId,
          requestId,
          maxPerGroup: match.watch.maxPerGroup,
        };
        const requestContext = {
          ...context,
          commandId: watchCommandId(context, match, event),
        };
        if (
          (await orchestration.isCausalRepeat?.(
            match.parent.workflowInstanceId,
            event.eventId,
            causalCycle,
            request.requestId,
          )) === true
        ) {
          await orchestration.rejectCausalActivation(request, requestContext);
          continue;
        }
        const result = await orchestration.requestChild(request, requestContext);
        if (result === undefined || result === null)
          throw new Error(`Watch child request ${request.requestId} did not complete durably`);
      }
    },
    async runOnce(limit = 100): Promise<number> {
      if (journal === undefined || checkpoints === undefined)
        throw new Error('WatchReactor journal and checkpoints are required to run');
      const events = await journal.readAll(await checkpoints.load(checkpoint), limit);
      for (const event of events) {
        await this.react(event, commandContext(event));
        await checkpoints.save(checkpoint, event.globalPosition);
      }
      return events.length;
    },
  };
}

function commandContext(event: PersistedEvent): CommandContext {
  return {
    commandId: `${event.eventId}:watch`,
    correlationId: correlationId(event.correlationId),
    occurredAt: event.occurredAt,
    actor: { kind: EventActorKind.System, id: 'watch-reactor' },
  };
}

function orchestrationCausalCycleId(event: OrchestrationEvent | null): string | undefined {
  return event !== null && 'causalCycleId' in event.payload
    ? event.payload.causalCycleId
    : undefined;
}

function watchCommandId(context: CommandContext, match: WatchMatch, event: PersistedEvent): string {
  return `${context.commandId}:parent:${match.parent.workflowInstanceId}:watch:${match.watch.id}:trigger:${event.eventId}`;
}
