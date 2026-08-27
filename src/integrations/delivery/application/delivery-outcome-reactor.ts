import { ActivityOutcomeKind, activationId } from '../../../activities/index.js';
import { type ConversationService } from '../../../conversations/index.js';
import {
  EventActorKind,
  type CheckpointStore,
  type EventEnvelope,
  type EventJournal,
  type ProjectionStore,
} from '../../../kernel/index.js';
import {
  ActivityActivationStatus,
  workflowInstanceId,
  type OrchestrationService,
  type WorkflowInstanceId,
} from '../../../orchestration/index.js';
import { IntegrationStreamKind } from '../../contracts/streams.js';
import { DeliveryEventType, selectDeliveryEvent } from '../contracts/events.js';
import type { DeliveryIntentView } from '../contracts/views.js';
import { DeliveryIntentKind, DeliveryResultKind } from '../contracts/vocabulary.js';

const deliveryResultSignalKind = 'delivery-result';
const pendingNamespace = 'reactor:delivery-outcomes:pending';
const pendingKey = 'pending-confirmations';

interface PendingConfirmations {
  readonly events: readonly EventEnvelope[];
}

export class DeliveryOutcomeReactor {
  constructor(
    private readonly journal: EventJournal,
    private readonly checkpoints: CheckpointStore,
    private readonly orchestration: Pick<OrchestrationService, 'acceptOutcome' | 'get'>,
    private readonly projections: ProjectionStore,
    private readonly conversations?: Pick<ConversationService, 'recordRepresentation'>,
  ) {}

  async runOnce(): Promise<number> {
    const consumer = 'reactor:delivery-outcomes';
    const events = await this.journal.readAll(await this.checkpoints.load(consumer));
    const resolved = new Set<string>();
    const pending = new Map(
      (await this.loadPending()).map((event) => [event.eventId, event] as const),
    );
    for (const event of events) {
      const matched = await this.reconcile(event, resolved);
      if (matched === false) {
        // reconcile() only ever returns false for a delivery-terminal event
        // (selectDeliveryEvent(event) !== null), so this lookup can't miss.
        const delivery = selectDeliveryEvent(event)!;
        pending.set(delivery.eventId, event);
      }
      await this.checkpoints.save(consumer, event.globalPosition);
    }
    // Catches a confirmation checkpointed before its workflow reached
    // "waiting for delivery" — re-checked here on every call rather than
    // relying on the incremental pass above, which never revisits a
    // position once checkpointed.
    for (const [id, pendingEvent] of pending) {
      if (resolved.has(id)) {
        pending.delete(id);
        continue;
      }
      const matched = await this.reconcile(pendingEvent, resolved);
      if (matched === true) pending.delete(id);
    }
    await this.savePending([...pending.values()]);
    return events.length;
  }

  // true: resolved (accepted this call, or already accepted earlier this
  // same call). false: a delivery-terminal event whose workflow isn't
  // waiting on it yet — belongs in the pending set for a later retry. null:
  // not a delivery-terminal event at all.
  private async reconcile(event: EventEnvelope, seen: Set<string>): Promise<boolean | null> {
    const delivery = selectDeliveryEvent(event);
    if (delivery === null) return null;
    if (seen.has(delivery.eventId)) return true;
    const outcome =
      delivery.eventType === DeliveryEventType.Confirmed ||
      (delivery.eventType === DeliveryEventType.Reconciled &&
        delivery.payload.result === DeliveryResultKind.Confirmed)
        ? { kind: ActivityOutcomeKind.Done, data: { deliveryEventId: delivery.eventId } }
        : delivery.eventType === DeliveryEventType.Failed
          ? { kind: ActivityOutcomeKind.Failed, data: { reason: delivery.payload.code } }
          : null;
    if (outcome === null) return null;
    try {
      await this.recordConversationRepresentation(event, delivery);
    } catch (error) {
      // Delivery reconciliation must continue if optional conversation provenance is unavailable.
      console.error(`Conversation provenance recording failed for ${delivery.eventId}`, error);
    }
    const command = {
      workflowInstanceId: workflowInstanceId(delivery.payload.workflowInstanceId),
      activationId: activationId(delivery.payload.activationId),
    };
    if (!(await this.isAwaitingThisDelivery(command, delivery.payload.intentEventId))) return false;
    seen.add(delivery.eventId);
    await this.orchestration.acceptOutcome(
      { ...command, outcome },
      {
        commandId: delivery.eventId,
        correlationId: event.correlationId,
        actor: { kind: EventActorKind.System, id: 'delivery-outcome-reactor' },
        occurredAt: event.recordedAt,
      },
    );
    return true;
  }

  private async recordConversationRepresentation(
    event: EventEnvelope,
    delivery: NonNullable<ReturnType<typeof selectDeliveryEvent>>,
  ): Promise<void> {
    if (this.conversations === undefined || !isConfirmedDelivery(delivery)) return;
    const intent = await conversationDeliveryIntent(
      this.projections,
      delivery.payload.intentEventId,
    );
    if (intent === undefined) return;
    const externalId = (delivery.payload as { readonly externalId?: string }).externalId;
    if (externalId === undefined) return;
    const payload = intent.payload as {
      readonly conversationId: string;
      readonly conversationEntryId: string;
    };
    await this.conversations.recordRepresentation(
      {
        conversationId: payload.conversationId as never,
        entryId: payload.conversationEntryId,
        resourceId: intent.resourceId,
        externalId,
      },
      {
        commandId: delivery.eventId,
        correlationId: event.correlationId,
        actor: { kind: EventActorKind.System, id: 'delivery-outcome-reactor' },
        occurredAt: event.recordedAt,
      },
    );
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

  private async loadPending(): Promise<readonly EventEnvelope[]> {
    const stored = await this.projections.read<PendingConfirmations>(pendingNamespace, pendingKey);
    return stored?.value.events ?? [];
  }

  private async savePending(events: readonly EventEnvelope[]): Promise<void> {
    await this.projections.write<PendingConfirmations>({
      namespace: pendingNamespace,
      key: pendingKey,
      lastGlobalPosition: 0,
      value: { events },
    });
  }
}

function isConfirmedDelivery(
  delivery: NonNullable<ReturnType<typeof selectDeliveryEvent>>,
): boolean {
  return (
    delivery.eventType === DeliveryEventType.Confirmed ||
    (delivery.eventType === DeliveryEventType.Reconciled &&
      delivery.payload.result === DeliveryResultKind.Confirmed)
  );
}

async function conversationDeliveryIntent(projections: ProjectionStore, intentEventId: string) {
  const intent = (await projections.list<DeliveryIntentView>(IntegrationStreamKind.Delivery)).find(
    (candidate) => candidate.value.intentEventId === intentEventId,
  )?.value;
  if (
    intent?.payload.kind !== DeliveryIntentKind.AgentRunPublish ||
    !('conversationId' in intent.payload) ||
    intent.payload.conversationId === undefined ||
    intent.payload.conversationEntryId === undefined
  )
    return undefined;
  return intent;
}
