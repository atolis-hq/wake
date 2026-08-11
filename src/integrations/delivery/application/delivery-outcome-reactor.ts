import { ActivityOutcomeKind, activationId } from '../../../activities/index.js';
import { EventActorKind, type CheckpointStore, type EventJournal } from '../../../kernel/index.js';
import {
  ActivityActivationStatus,
  workflowInstanceId,
  type OrchestrationService,
  type WorkflowInstanceId,
} from '../../../orchestration/index.js';
import { DeliveryEventType, selectDeliveryEvent } from '../contracts/events.js';
import { DeliveryResultKind } from '../contracts/vocabulary.js';

const deliveryResultSignalKind = 'delivery-result';

export class DeliveryOutcomeReactor {
  constructor(
    private readonly journal: EventJournal,
    private readonly checkpoints: CheckpointStore,
    private readonly orchestration: Pick<OrchestrationService, 'acceptOutcome' | 'get'>,
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
        if (await this.isAwaitingThisDelivery(command, delivery.payload.intentEventId)) {
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
      }
      await this.checkpoints.save(consumer, event.globalPosition);
    }
    return events.length;
  }

  /**
   * A delivery's own completion may only resolve the activation that
   * actually asked to wait on it (an activity outcome of `waiting` with
   * `signalKind: 'delivery-result'`, e.g. pr.approve/pr.merge) — never a
   * merely-still-open activation left pending for an unrelated reason
   * (e.g. a technical failure with no configured route for that stage).
   */
  private async isAwaitingThisDelivery(
    command: { readonly workflowInstanceId: WorkflowInstanceId; readonly activationId: string },
    intentEventId: string,
  ): Promise<boolean> {
    const view = await this.orchestration.get(command.workflowInstanceId);
    return (
      view?.pendingActivation?.activationId === command.activationId &&
      view.pendingActivation.status === ActivityActivationStatus.Waiting &&
      view.waitingFor?.signalKind === deliveryResultSignalKind &&
      view.waitingFor.intentEventId === intentEventId
    );
  }
}
