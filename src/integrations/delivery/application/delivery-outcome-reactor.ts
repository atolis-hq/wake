import { z } from 'zod';
import { activationId, ActivityOutcomeKind } from '../../../activities/index.js';
import { type ConversationService } from '../../../conversations/index.js';
import {
  defineEventProcessor,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  type EventProcessor,
} from '../../../eventing/index.js';
import {
  decodeEventEnvelope,
  entityRefSchema,
  EventActorKind,
  eventDataSchema,
  eventEnvelopeSchema,
  offsetIsoTimestampSchema,
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

const pendingConfirmationsSchema = z.object({ events: z.array(z.unknown()) }).strict();
const legacyPendingEnvelopeSchema = eventDataSchema
  .omit({ payload: true })
  .extend({
    stream: entityRefSchema,
    payload: z.unknown(),
    recordedAt: offsetIsoTimestampSchema,
    sequence: z.number().int().positive(),
    globalPosition: z.number().int().positive(),
  })
  .strict();

export class DeliveryOutcomeReactor {
  readonly processor: EventProcessor;

  constructor(
    private readonly journal: EventJournal,
    private readonly orchestration: Pick<OrchestrationService, 'acceptOutcome' | 'get'>,
    private readonly projections: ProjectionStore,
    private readonly conversations?: Pick<ConversationService, 'recordRepresentation'>,
  ) {
    this.processor = defineEventProcessor({
      consumer: 'reactor:delivery-outcomes',
      name: 'delivery-outcomes',
      owner: 'integrations',
      category: EventProcessorCategory.Reactor,
      replayPolicy: EventProcessorReplayPolicy.Idempotent,
      select(event) {
        return isResolvedDelivery(selectDeliveryEvent(event)) ? event : null;
      },
      handle: async (event) => this.react(event),
    });
  }

  async react(event: EventEnvelope): Promise<void> {
    if ((await this.reconcile(event)) === false) await this.savePendingEvent(event);
  }

  async reconcileOnce(): Promise<void> {
    const pending = new Map(
      (await this.loadPending()).map((event) => [event.event.eventId, event]),
    );
    for (const [id, event] of pending) {
      if ((await this.reconcile(event)) === true) pending.delete(id);
    }
    await this.savePending([...pending.values()]);
  }

  private async reconcile(event: EventEnvelope): Promise<boolean | null> {
    const delivery = selectDeliveryEvent(event);
    if (delivery === null) return null;
    const outcome =
      delivery.event.eventType === DeliveryEventType.Confirmed ||
      (delivery.event.eventType === DeliveryEventType.Reconciled &&
        delivery.event.payload.result === DeliveryResultKind.Confirmed)
        ? { kind: ActivityOutcomeKind.Done, data: { deliveryEventId: delivery.event.eventId } }
        : delivery.event.eventType === DeliveryEventType.Failed
          ? { kind: ActivityOutcomeKind.Failed, data: { reason: delivery.event.payload.code } }
          : null;
    if (outcome === null) return null;
    try {
      await this.recordConversationRepresentation(event, delivery);
    } catch (error) {
      // Optional conversation provenance must not block delivery reconciliation.
      console.error(
        `Conversation provenance recording failed for ${delivery.event.eventId}`,
        error,
      );
    }
    const command = {
      workflowInstanceId: workflowInstanceId(delivery.event.payload.workflowInstanceId),
      activationId: activationId(delivery.event.payload.activationId),
    };
    if (!(await this.isAwaitingThisDelivery(command, delivery.event.payload.intentEventId)))
      return false;
    await this.orchestration.acceptOutcome(
      { ...command, outcome },
      {
        commandId: delivery.event.eventId,
        correlationId: event.event.correlationId,
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
      delivery.event.payload.intentEventId,
    );
    if (intent === undefined) return;
    const externalId = confirmedExternalId(delivery);
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
        commandId: delivery.event.eventId,
        correlationId: event.event.correlationId,
        actor: { kind: EventActorKind.System, id: 'delivery-outcome-reactor' },
        occurredAt: event.recordedAt,
      },
    );
  }

  private async isAwaitingThisDelivery(
    command: { readonly workflowInstanceId: WorkflowInstanceId; readonly activationId: string },
    intentEventId: string,
  ): Promise<boolean> {
    // A terminal delivery can only resolve the activation that waited for this exact intent.
    const view = await this.orchestration.get(command.workflowInstanceId);
    return (
      view?.pendingActivation?.activationId === command.activationId &&
      view.pendingActivation.status === ActivityActivationStatus.Waiting &&
      view.waitingFor?.signalKind === deliveryResultSignalKind &&
      view.waitingFor.intentEventId === intentEventId
    );
  }

  private async loadPending(): Promise<readonly EventEnvelope[]> {
    const stored = await this.projections.read<unknown>(pendingNamespace, pendingKey);
    if (stored === null) return [];
    return pendingConfirmationsSchema.parse(stored.value).events.map(decodePendingEnvelope);
  }

  private async savePending(events: readonly EventEnvelope[]): Promise<void> {
    await this.projections.write<PendingConfirmations>({
      namespace: pendingNamespace,
      key: pendingKey,
      lastGlobalPosition: 0,
      value: { events },
    });
  }

  private async savePendingEvent(event: EventEnvelope): Promise<void> {
    const pending = new Map(
      (await this.loadPending()).map((value) => [value.event.eventId, value]),
    );
    pending.set(event.event.eventId, event);
    await this.savePending([...pending.values()]);
  }
}

function decodePendingEnvelope(value: unknown): EventEnvelope {
  const nested = eventEnvelopeSchema.safeParse(value);
  if (nested.success) return nested.data;
  const legacy = legacyPendingEnvelopeSchema.parse(value);
  return decodeEventEnvelope({
    event: {
      eventId: legacy.eventId,
      eventType: legacy.eventType,
      schemaVersion: legacy.schemaVersion,
      occurredAt: legacy.occurredAt,
      correlationId: legacy.correlationId,
      causationId: legacy.causationId,
      actor: legacy.actor,
      source: legacy.source,
      payload: legacy.payload,
    },
    stream: legacy.stream,
    recordedAt: legacy.recordedAt,
    sequence: legacy.sequence,
    globalPosition: legacy.globalPosition,
  });
}

function isResolvedDelivery(
  delivery: ReturnType<typeof selectDeliveryEvent>,
): delivery is NonNullable<ReturnType<typeof selectDeliveryEvent>> {
  return (
    delivery?.event.eventType === DeliveryEventType.Confirmed ||
    delivery?.event.eventType === DeliveryEventType.Failed ||
    (delivery?.event.eventType === DeliveryEventType.Reconciled &&
      delivery.event.payload.result === DeliveryResultKind.Confirmed)
  );
}

function isConfirmedDelivery(
  delivery: NonNullable<ReturnType<typeof selectDeliveryEvent>>,
): boolean {
  return (
    delivery.event.eventType === DeliveryEventType.Confirmed ||
    (delivery.event.eventType === DeliveryEventType.Reconciled &&
      delivery.event.payload.result === DeliveryResultKind.Confirmed)
  );
}

function confirmedExternalId(
  delivery: NonNullable<ReturnType<typeof selectDeliveryEvent>>,
): string | undefined {
  if (delivery.event.eventType === DeliveryEventType.Confirmed)
    return delivery.event.payload.externalId;
  return delivery.event.eventType === DeliveryEventType.Reconciled &&
    delivery.event.payload.result === DeliveryResultKind.Confirmed
    ? delivery.event.payload.externalId
    : undefined;
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
