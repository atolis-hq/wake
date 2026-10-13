import {
  EventActorKind,
  EventSourceKind,
  type CommandContext,
  type EventJournal,
} from '@atolis-hq/eventing';
import type { OrchestrationService } from '../../orchestration/index.js';
import { resourceId, resourceStream } from '../../resources/index.js';
import { createDeliveryIntentEventData } from '../delivery/contracts/event-factory.js';
import { DeliveryIntentEventType } from '../delivery/contracts/intents.js';

/** Publish command feedback through the same durable delivery lane as activity replies. */
export async function publishConversationCommandFeedback(input: {
  readonly journal: EventJournal;
  readonly orchestration: OrchestrationService;
  readonly workItemId: Parameters<OrchestrationService['listForWorkItem']>[0];
  readonly resourceId: string;
  readonly body: string;
  readonly context: CommandContext;
}): Promise<void> {
  const primary = (await input.orchestration.listAll())
    .filter((workflow) => workflow.workItemId === input.workItemId)
    .find((workflow) => workflow.parentWorkflowInstanceId === undefined);
  if (primary?.pendingActivation === undefined) return;
  const target = resourceId(input.resourceId);
  const stream = resourceStream(target);
  const eventId = `${input.context.commandId}:feedback-delivery`;
  const events = await input.journal.readStream(stream);
  if (events.some((event) => event.event.eventId === eventId)) return;
  await input.journal.appendToStream(stream, events.length, [
    createDeliveryIntentEventData({
      eventId,
      eventType: DeliveryIntentEventType.ReplyPublishRequested,
      occurredAt: input.context.occurredAt,
      correlationId: input.context.correlationId,
      causationId: input.context.commandId,
      actor: { kind: EventActorKind.System, id: 'conversation-command-feedback' },
      source: { kind: EventSourceKind.Internal, id: 'conversation-command-feedback' },
      payload: {
        resourceId: target,
        publicationOnly: true,
        workflowInstanceId: primary.workflowInstanceId,
        activationId: primary.pendingActivation.activationId,
        body: input.body,
      },
    }),
  ]);
}
