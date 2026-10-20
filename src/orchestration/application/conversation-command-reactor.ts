import type { CommandContext } from '@atolis-hq/eventing';
import {
  EventActorKind,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  correlationId,
  defineEventProcessor,
  type EventProcessor,
} from '@atolis-hq/eventing';
import type { ConversationService } from '../../conversations/index.js';
import {
  ConversationEventType,
  ConversationOriginKind,
  selectConversationEvent,
  workItemIdForConversation,
  type ConversationEventPayloads,
} from '../../conversations/index.js';
import type { ConversationCommandInput, SurfaceCapability } from './conversation-command.js';
import { conversationCommand } from './conversation-command.js';
import type { OrchestrationService } from './orchestration-service.js';

type ConversationCommandMessage = {
  readonly conversationId: Parameters<typeof workItemIdForConversation>[0];
  readonly eventId: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly entry: ConversationEventPayloads[typeof ConversationEventType.EntryRecorded];
};

interface ConversationCommandFeedback {
  readonly conversations: ConversationService;
  readonly publish: (
    event: ConversationCommandMessage,
    body: string,
    context: CommandContext,
  ) => Promise<void>;
}

/** Applies human commands only after their external message is canonical conversation history. */
export function createConversationCommandReactor(
  orchestration: OrchestrationService,
  feedback?: ConversationCommandFeedback,
): { readonly processor: EventProcessor } {
  return {
    processor: defineEventProcessor<ConversationCommandMessage>({
      consumer: 'reactor:orchestration.conversation-command',
      name: 'orchestration.conversation-command',
      owner: 'orchestration',
      category: EventProcessorCategory.Reactor,
      replayPolicy: EventProcessorReplayPolicy.Idempotent,
      select(event) {
        const conversation = selectConversationEvent(event);
        if (conversation?.event.eventType !== ConversationEventType.EntryRecorded) return null;
        return {
          conversationId: conversation.stream.id,
          eventId: conversation.event.eventId,
          correlationId: conversation.event.correlationId,
          occurredAt: conversation.event.occurredAt,
          entry: conversation.event.payload as ConversationCommandMessage['entry'],
        };
      },
      async handle(event) {
        if (event === null) return;
        const { entry } = event;
        if (entry.origin.kind !== ConversationOriginKind.External) return;
        const workItemId = workItemIdForConversation(event.conversationId);
        const input = {
          body: entry.body,
          actorId: entry.origin.actorId,
          capabilities: (entry.origin.capabilities ?? []) as readonly SurfaceCapability[],
          authorized: entry.origin.authorized === true,
          // Legacy entries authorized commands only after enforcing review independence.
          reviewAuthorized: entry.origin.reviewAuthorized ?? entry.origin.authorized === true,
        };
        const context: CommandContext = {
          commandId: `${event.eventId}:conversation-command`,
          correlationId: correlationId(event.correlationId),
          occurredAt: event.occurredAt,
          actor: { kind: EventActorKind.Integration, id: entry.origin.adapter },
        };
        if (conversationCommand(entry.body) !== null) {
          await applyExternalCommand(orchestration, feedback, event, input, context);
          return;
        }
        if (entry.origin.canClarify === false) return;
        await routeEscalatedReply(orchestration, feedback, event, workItemId, entry.origin.adapter);
        for (const workflow of await orchestration.listAll()) {
          if (workflow.workItemId !== workItemId) continue;
          const resume = input.authorized
            ? orchestration.resumeBlockedStageForReply.bind(orchestration)
            : orchestration.resumeNeedsClarificationStage.bind(orchestration);
          await resume(workflow.workflowInstanceId, {
            commandId: `${event.eventId}:conversation-reply`,
            correlationId: correlationId(event.correlationId),
            occurredAt: event.occurredAt,
            actor: { kind: EventActorKind.Integration, id: entry.origin.adapter },
          });
        }
      },
    }),
  };
}

/**
 * A parent that escalated a delegated child's question to a human has no stage to resume. The
 * human's reply is recorded on each asking child's own conversation, where the ordinary reply path
 * resumes it; the cohort stays tracked and nothing is settled or joined.
 */
async function routeEscalatedReply(
  orchestration: OrchestrationService,
  feedback: ConversationCommandFeedback | undefined,
  event: ConversationCommandMessage,
  workItemId: ReturnType<typeof workItemIdForConversation>,
  adapter: string,
): Promise<void> {
  if (feedback === undefined) return;
  const context: CommandContext = {
    commandId: `${event.eventId}:escalated-reply`,
    correlationId: correlationId(event.correlationId),
    occurredAt: event.occurredAt,
    actor: { kind: EventActorKind.Integration, id: adapter },
  };
  for (const childWorkItemId of await orchestration.escalatedReplyTargets(workItemId)) {
    const conversation = await feedback.conversations.createForWorkItem(childWorkItemId, context);
    await feedback.conversations.record(
      {
        conversationId: conversation.conversationId,
        entryId: `${event.eventId}:routed:${childWorkItemId}`,
        body: event.entry.body,
        origin: event.entry.origin,
      },
      context,
    );
  }
}

async function applyExternalCommand(
  orchestration: OrchestrationService,
  feedback: ConversationCommandFeedback | undefined,
  event: ConversationCommandMessage,
  input: ConversationCommandInput,
  context: CommandContext,
): Promise<void> {
  const entryId = context.commandId + ':feedback';
  const canPublish = input.authorized || input.reviewAuthorized === true;
  const prior = (await feedback?.conversations.get(event.conversationId))?.entries.find(
    (entry) => entry.entryId === entryId,
  );
  // A recorded receipt fixes the result even if publication retries after the workflow changes.
  if (prior !== undefined && feedback !== undefined) {
    if (canPublish && prior.body !== 'Command applied.')
      await feedback.publish(event, prior.body, context);
    return;
  }
  const result = await orchestration.applyConversationCommandWithFeedback(
    workItemIdForConversation(event.conversationId),
    input,
    context,
  );
  if (feedback === undefined) return;
  const body = result.applied ? 'Command applied.' : 'Command not applied: ' + result.reason;
  await feedback.conversations.record(
    {
      conversationId: event.conversationId,
      entryId,
      body,
      origin: { kind: ConversationOriginKind.ControlPlane, actorId: 'wake' },
    },
    context,
  );
  if (canPublish && !result.applied) await feedback.publish(event, body, context);
}
