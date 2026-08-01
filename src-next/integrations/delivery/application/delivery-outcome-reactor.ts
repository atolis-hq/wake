import { ActivityOutcomeKind, activationId } from '../../../activities/index.js';
import { EventActorKind, type CheckpointStore, type EventJournal } from '../../../kernel/index.js';
import { workflowInstanceId, type OrchestrationService } from '../../../orchestration/index.js';
import { DeliveryEventType, selectDeliveryEvent } from '../contracts/events.js';
import { DeliveryResultKind } from '../contracts/vocabulary.js';

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
      const delivery = selectDeliveryEvent(event);
      if (delivery !== null) {
        const command = {
          workflowInstanceId: workflowInstanceId(delivery.payload.workflowInstanceId),
          activationId: activationId(delivery.payload.activationId),
        };
        if (
          delivery.eventType === DeliveryEventType.Confirmed ||
          (delivery.eventType === DeliveryEventType.Reconciled &&
            delivery.payload.result === DeliveryResultKind.Confirmed)
        )
          await this.orchestration.acceptOutcome(
            {
              ...command,
              outcome: {
                kind: ActivityOutcomeKind.Done,
                data: { deliveryEventId: delivery.eventId },
              },
            },
            {
              commandId: delivery.eventId,
              correlationId: event.correlationId,
              actor: { kind: EventActorKind.System, id: 'delivery-outcome-reactor' },
              occurredAt: event.recordedAt,
            },
          );
        if (delivery.eventType === DeliveryEventType.Failed)
          await this.orchestration.acceptOutcome(
            {
              ...command,
              outcome: {
                kind: ActivityOutcomeKind.Failed,
                data: { reason: delivery.payload.code },
              },
            },
            {
              commandId: delivery.eventId,
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
