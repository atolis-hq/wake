import { z } from 'zod';
import {
  ActivityExecutionKind,
  activityName,
  ActivityOutcomeKind,
  type ActivityDefinition,
} from '../activities/index.js';
import { DeliveryIntentEventType } from '../integrations/index.js';
import {
  createEventData,
  EventActorKind,
  EventSourceKind,
  type EventJournal,
} from '../kernel/index.js';
import { resourceStream } from '../resources/index.js';

export function createStatusPublishActivity(
  journal: EventJournal,
): ActivityDefinition<
  ReturnType<typeof activityName>,
  { body: string },
  { kind: typeof ActivityOutcomeKind.Done }
> {
  return {
    name: activityName('status.publish'),
    inputSchema: z.object({ body: z.string().min(1) }).strict(),
    outcomeSchema: z.object({ kind: z.literal(ActivityOutcomeKind.Done) }).strict(),
    outcomeKinds: [ActivityOutcomeKind.Done],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      async execute(invocation) {
        const resource = invocation.resources[0];
        if (resource === undefined) throw new Error('status.publish requires an intake resource');
        const sequence = (await journal.readStream(resourceStream(resource.resourceId))).length;
        await journal.appendToStream(resourceStream(resource.resourceId), sequence, [
          createEventData({
            eventId: `${invocation.activationId}:status.publish`,
            eventType: DeliveryIntentEventType.StatusPublishRequested,
            occurredAt: new Date().toISOString(),
            correlationId: invocation.causationId,
            causationId: invocation.causationId,
            actor: { kind: EventActorKind.System, id: 'status.publish' },
            source: { kind: EventSourceKind.Internal, id: 'status.publish' },
            stream: resourceStream(resource.resourceId),
            payload: {
              workflowInstanceId: invocation.workflowInstanceId,
              activationId: invocation.activationId,
              resourceId: resource.resourceId,
              body: invocation.input.body,
            },
          }),
        ]);
        return { kind: ActivityOutcomeKind.Done };
      },
    },
  };
}
