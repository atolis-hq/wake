import {
  defineEventProcessor,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
} from '../../eventing/index.js';
import { correlationId, EventActorKind, type CommandContext } from '../../kernel/index.js';
import type { TransitionTarget } from '../contracts/config.js';
import { selectOrchestrationEvent } from '../contracts/event-decoder.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import type { ResourceTransitionEvidence } from './resource-transition-evidence.js';
import type { ResourceTransitionMatch } from './resource-transition-matching.js';

type PersistedEvent = Parameters<typeof selectOrchestrationEvent>[0];

interface ResourceTransitionOrchestrationPort {
  listResourceTransitionMatches(event: PersistedEvent): Promise<readonly ResourceTransitionMatch[]>;
  applyResourceTransition(
    workflowInstanceId: WorkflowInstanceId,
    target: TransitionTarget,
    evidenceId: string,
    context: CommandContext,
  ): Promise<unknown>;
}

const checkpoint = 'reactor:orchestration.resource-transition';
const batchSize = 100;

export function createResourceTransitionReactor(
  orchestration: ResourceTransitionOrchestrationPort,
  evidence: ResourceTransitionEvidence,
) {
  const react = async (event: PersistedEvent, context: CommandContext): Promise<void> => {
    const orchestrationEvent = selectOrchestrationEvent(event);
    const isWaitStart =
      orchestrationEvent?.event.eventType === OrchestrationEventType.SignalWaitStarted;
    if (!isWaitStart && !evidence.triggers.includes(event.event.eventType)) return;
    const fact = isWaitStart ? undefined : event;
    for (const match of await orchestration.listResourceTransitionMatches(event)) {
      const resolved = await evidence.resolve({
        workItemId: match.workItemId,
        transitions: match.transitions,
        ...(fact === undefined ? {} : { fact }),
      });
      if (resolved === null) continue;
      await orchestration.applyResourceTransition(
        match.workflowInstanceId,
        resolved.transition.target,
        resolved.evidenceId,
        context,
      );
    }
  };
  return {
    react,
    processor: defineEventProcessor({
      consumer: checkpoint,
      name: 'resource-transition',
      owner: 'orchestration',
      category: EventProcessorCategory.Reactor,
      replayPolicy: EventProcessorReplayPolicy.Idempotent,
      batchSize,
      select(event) {
        const orchestrationEvent = selectOrchestrationEvent(event);
        return orchestrationEvent?.event.eventType === OrchestrationEventType.SignalWaitStarted ||
          evidence.triggers.includes(event.event.eventType)
          ? event
          : null;
      },
      handle: async (event) => react(event, commandContext(event)),
    }),
  };
}

function commandContext(event: PersistedEvent): CommandContext {
  return {
    commandId: `${event.event.eventId}:resource-transition`,
    correlationId: correlationId(event.event.correlationId),
    occurredAt: event.event.occurredAt,
    actor: { kind: EventActorKind.System, id: 'resource-transition-reactor' },
  };
}
