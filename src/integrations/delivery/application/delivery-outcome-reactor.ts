import {
  correlationId,
  defineEventProcessor,
  entityRefSchema,
  EventActorKind,
  eventDataSchema,
  eventEnvelopeSchema,
  eventId,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  type CorrelationId,
  type EventEnvelope,
  type EventId,
  type EventJournal,
  type EventProcessor,
  type ProcessorRunSerialiser,
  type ProcessorStateStore,
  type ProjectionStore,
} from '@atolis-hq/eventing';
import { z } from 'zod';
import { activationId, ActivityOutcomeKind } from '../../../activities/index.js';
import { type ConversationService } from '../../../conversations/index.js';
import { brandedStringSchema, offsetIsoTimestampSchema } from '../../../kernel/index.js';
import {
  ActivityActivationStatus,
  workflowInstanceId,
  type OrchestrationService,
  type WorkflowInstanceId,
} from '../../../orchestration/index.js';
import { IntegrationStreamKind } from '../../contracts/streams.js';
import {
  DeliveryEventType,
  selectDeliveryEvent,
  type DeliveryEventPayloads,
} from '../contracts/events.js';
import type { DeliveryIntentView } from '../contracts/views.js';
import { DeliveryIntentKind, DeliveryResultKind } from '../contracts/vocabulary.js';

const deliveryResultSignalKind = 'delivery-result';

export const DeliveryOutcomeProcessorConsumer = 'reactor:delivery-outcomes';
const pendingConsumer = DeliveryOutcomeProcessorConsumer;
const pendingKey = 'pending-confirmations';

type PendingDeliveryOutcome =
  | PendingDeliveryOutcomeOf<typeof DeliveryEventType.Confirmed>
  | PendingDeliveryOutcomeOf<typeof DeliveryEventType.Failed>
  | (PendingDeliveryOutcomeOf<typeof DeliveryEventType.Reconciled> & {
      readonly payload: DeliveryEventPayloads[typeof DeliveryEventType.Reconciled] & {
        readonly result: typeof DeliveryResultKind.Confirmed;
        readonly externalId: string;
      };
    });

interface PendingDeliveryOutcomeOf<Type extends keyof DeliveryEventPayloads> {
  readonly eventId: EventId;
  readonly eventType: Type;
  readonly correlationId: CorrelationId;
  readonly recordedAt: string;
  readonly payload: DeliveryEventPayloads[Type];
}

interface PendingConfirmations {
  readonly events: readonly PendingDeliveryOutcome[];
}

const pendingConfirmationsSchema = z.object({ events: z.array(z.unknown()) }).strict();
const pendingCorrelationSchema = z
  .object({
    intentEventId: brandedStringSchema(eventId),
    intentGlobalPosition: z.number().int().positive(),
    workflowInstanceId: z.string().min(1),
    activationId: z.string().min(1),
    occurrenceOrdinal: z.number().int().positive(),
  })
  .strict();
const pendingOutcomeHeaderSchema = z
  .object({
    eventId: brandedStringSchema(eventId),
    correlationId: brandedStringSchema(correlationId),
    recordedAt: offsetIsoTimestampSchema,
  })
  .strict();
const pendingDeliveryOutcomeSchema: z.ZodType<PendingDeliveryOutcome> = z.discriminatedUnion(
  'eventType',
  [
    pendingOutcomeHeaderSchema.extend({
      eventType: z.literal(DeliveryEventType.Confirmed),
      payload: pendingCorrelationSchema.extend({ externalId: z.string().min(1) }),
    }),
    pendingOutcomeHeaderSchema.extend({
      eventType: z.literal(DeliveryEventType.Failed),
      payload: pendingCorrelationSchema.extend({
        code: z.string().min(1),
        message: z.string().min(1),
      }),
    }),
    pendingOutcomeHeaderSchema.extend({
      eventType: z.literal(DeliveryEventType.Reconciled),
      payload: pendingCorrelationSchema.extend({
        result: z.literal(DeliveryResultKind.Confirmed),
        externalId: z.string().min(1),
      }),
    }),
  ],
);
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
    private readonly processorState: ProcessorStateStore,
    private readonly conversations: Pick<ConversationService, 'recordRepresentation'> | undefined,
    private readonly serialiseRun: ProcessorRunSerialiser,
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
      // EventProcessorHost already holds this consumer's serialiser while
      // invoking the handler. Acquiring it again here would deadlock.
      handle: async (event) => this.reactWithinProcessor(event),
    });
  }

  react(event: EventEnvelope, signal: AbortSignal = new AbortController().signal): Promise<void> {
    return this.serialiseRun(this.processor.consumer, signal, () =>
      this.reactWithinProcessor(event),
    );
  }

  private async reactWithinProcessor(event: EventEnvelope): Promise<void> {
    const delivery = selectDeliveryEvent(event);
    if (!isResolvedDelivery(delivery)) return;
    const pending = projectPendingDeliveryOutcome(event, delivery);
    if ((await this.reconcile(pending)) === false) await this.savePendingEvent(pending);
  }

  reconcileOnce(signal: AbortSignal = new AbortController().signal): Promise<void> {
    return this.serialiseRun(this.processor.consumer, signal, () => this.reconcilePendingOnce());
  }

  private async reconcilePendingOnce(): Promise<void> {
    const pending = new Map((await this.loadPending()).map((event) => [event.eventId, event]));
    for (const [id, event] of pending) {
      if ((await this.reconcile(event)) === true) pending.delete(id);
    }
    await this.savePending([...pending.values()]);
  }

  private async reconcile(delivery: PendingDeliveryOutcome): Promise<boolean> {
    const outcome =
      delivery.eventType === DeliveryEventType.Confirmed ||
      delivery.eventType === DeliveryEventType.Reconciled
        ? { kind: ActivityOutcomeKind.Done, data: { deliveryEventId: delivery.eventId } }
        : { kind: ActivityOutcomeKind.Failed, data: { reason: delivery.payload.code } };
    try {
      await this.recordConversationRepresentation(delivery);
    } catch (error) {
      // Optional conversation provenance must not block delivery reconciliation.
      console.error(`Conversation provenance recording failed for ${delivery.eventId}`, error);
    }
    const command = {
      workflowInstanceId: workflowInstanceId(delivery.payload.workflowInstanceId),
      activationId: activationId(delivery.payload.activationId),
    };
    if (!(await this.isAwaitingThisDelivery(command, delivery.payload.intentEventId))) return false;
    await this.orchestration.acceptOutcome(
      { ...command, outcome },
      {
        commandId: delivery.eventId,
        correlationId: delivery.correlationId,
        actor: { kind: EventActorKind.System, id: 'delivery-outcome-reactor' },
        occurredAt: delivery.recordedAt,
      },
    );
    return true;
  }

  private async recordConversationRepresentation(delivery: PendingDeliveryOutcome): Promise<void> {
    if (this.conversations === undefined || !isConfirmedDelivery(delivery)) return;
    const intent = await conversationDeliveryIntent(
      this.projections,
      delivery.payload.intentEventId,
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
        commandId: delivery.eventId,
        correlationId: delivery.correlationId,
        actor: { kind: EventActorKind.System, id: 'delivery-outcome-reactor' },
        occurredAt: delivery.recordedAt,
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

  private async loadPending(): Promise<readonly PendingDeliveryOutcome[]> {
    const stored = await this.processorState.read<unknown>(pendingConsumer, pendingKey);
    if (stored === null) return [];
    return pendingConfirmationsSchema.parse(stored.value).events.map(decodePendingOutcome);
  }

  private async savePending(events: readonly PendingDeliveryOutcome[]): Promise<void> {
    await this.processorState.write<PendingConfirmations>({
      consumer: pendingConsumer,
      key: pendingKey,
      value: { events },
    });
  }

  private async savePendingEvent(event: PendingDeliveryOutcome): Promise<void> {
    const pending = new Map((await this.loadPending()).map((value) => [value.eventId, value]));
    pending.set(event.eventId, event);
    await this.savePending([...pending.values()]);
  }
}

function decodePendingOutcome(value: unknown): PendingDeliveryOutcome {
  const canonical = pendingDeliveryOutcomeSchema.safeParse(value);
  if (canonical.success) return canonical.data;
  const nested = eventEnvelopeSchema.safeParse(value);
  if (nested.success) {
    const delivery = selectDeliveryEvent(nested.data);
    if (isResolvedDelivery(delivery)) return projectPendingDeliveryOutcome(nested.data, delivery);
  }
  const legacy = legacyPendingEnvelopeSchema.parse(value);
  return pendingDeliveryOutcomeSchema.parse({
    eventId: legacy.eventId,
    eventType: legacy.eventType,
    correlationId: legacy.correlationId,
    recordedAt: legacy.recordedAt,
    payload: legacy.payload,
  });
}

function projectPendingDeliveryOutcome(
  envelope: EventEnvelope,
  delivery: NonNullable<ReturnType<typeof selectDeliveryEvent>>,
): PendingDeliveryOutcome {
  return pendingDeliveryOutcomeSchema.parse({
    eventId: delivery.event.eventId,
    eventType: delivery.event.eventType,
    correlationId: envelope.event.correlationId,
    recordedAt: envelope.recordedAt,
    payload: delivery.event.payload,
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

function isConfirmedDelivery(delivery: PendingDeliveryOutcome): boolean {
  return (
    delivery.eventType === DeliveryEventType.Confirmed ||
    delivery.eventType === DeliveryEventType.Reconciled
  );
}

function confirmedExternalId(delivery: PendingDeliveryOutcome): string | undefined {
  return delivery.eventType === DeliveryEventType.Failed ? undefined : delivery.payload.externalId;
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
