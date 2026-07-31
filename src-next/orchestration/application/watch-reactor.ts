import {
  correlationId,
  type CheckpointStore,
  type CommandContext,
  type EventEnvelope,
  type EventJournal,
} from '../../kernel/index.js';
import type { ChildWorkflowRequest } from '../contracts/events.js';

interface WatchMatch {
  readonly parent: { readonly workflowInstanceId: string };
  readonly watch: {
    readonly id: string;
    readonly workflow: string;
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
    payload: unknown,
    requestId: string,
  ): Promise<boolean>;
}

interface CanonicalEvent {
  readonly eventType: string;
  readonly eventId: string;
  readonly payload: unknown;
}

const checkpoint = 'reactor:orchestration.watch';

export function createWatchReactor(
  orchestration: WatchOrchestrationPort,
  journal?: EventJournal,
  checkpoints?: CheckpointStore,
) {
  return {
    async react(event: CanonicalEvent, context: CommandContext): Promise<void> {
      for (const match of await orchestration.listWatchMatches(event.eventType)) {
        const requestId = `${match.parent.workflowInstanceId}:watch:${match.watch.id}:trigger:${event.eventId}`;
        const request = {
          parentWorkflowInstanceId: match.parent.workflowInstanceId,
          watchId: match.watch.id,
          triggerId: event.eventId,
          workflowName: match.watch.workflow,
          causalCycleId: causalCycleId(event.payload) ?? requestId,
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
            event.payload,
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

function commandContext(event: EventEnvelope): CommandContext {
  return {
    commandId: `${event.eventId}:watch`,
    correlationId: correlationId(event.correlationId),
    occurredAt: event.occurredAt,
    actor: { kind: 'system', id: 'watch-reactor' },
  };
}

function causalCycleId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('causalCycleId' in payload))
    return undefined;
  const value = payload.causalCycleId;
  return typeof value === 'string' ? value : undefined;
}

function watchCommandId(context: CommandContext, match: WatchMatch, event: CanonicalEvent): string {
  return `${context.commandId}:parent:${match.parent.workflowInstanceId}:watch:${match.watch.id}:trigger:${event.eventId}`;
}
