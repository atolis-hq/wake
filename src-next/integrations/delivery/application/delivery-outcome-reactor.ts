import { EventActorKind, type CheckpointStore, type EventJournal } from '../../../kernel/index.js';
import { ActivityOutcomeKind } from '../../../activities/index.js';
import { DeliveryEventType } from '../contracts/events.js';
import type { OrchestrationService } from '../../../orchestration/index.js';

/** Delivers terminal provider facts to the public orchestration API after a durable checkpoint. */
export class DeliveryOutcomeReactor {
  constructor(
    private readonly journal: EventJournal,
    private readonly checkpoints: CheckpointStore,
    private readonly orchestration: Pick<OrchestrationService, 'acceptOutcome'>,
  ) {}
  async runOnce(): Promise<number> {
    const consumer = 'reactor:delivery-outcomes';
    const events = await this.journal.readAll(await this.checkpoints.load(consumer));
    for (const event of events) {
      // Activation correlation is intentionally optional: delivery facts can also represent integration publishing.
      const payload = event.payload as Record<string, unknown>;
      if (
        (event.eventType === DeliveryEventType.Confirmed ||
          event.eventType === DeliveryEventType.Failed) &&
        typeof payload.workflowInstanceId === 'string' &&
        typeof payload.activationId === 'string'
      ) {
        await this.orchestration.acceptOutcome(
          {
            workflowInstanceId: payload.workflowInstanceId as never,
            activationId: payload.activationId as never,
            outcome:
              event.eventType === DeliveryEventType.Confirmed
                ? { kind: ActivityOutcomeKind.Done, data: { deliveryEventId: event.eventId } }
                : {
                    kind: ActivityOutcomeKind.Failed,
                    data: { reason: String(payload.code ?? 'delivery-failed') },
                  },
          },
          {
            commandId: event.eventId,
            correlationId: event.correlationId,
            actor: { kind: EventActorKind.System, id: 'delivery-outcome-reactor' },
            occurredAt: event.recordedAt,
          },
        );
      }
      await this.checkpoints.save(consumer, event.globalPosition);
    }
    return events.length;
  }
}
