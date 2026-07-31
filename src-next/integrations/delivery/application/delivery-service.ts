import { EventActorKind, EventSourceKind, type EventJournal } from '../../../kernel/index.js';
import { deliveryStream, IntegrationStreamKind } from '../../contracts/streams.js';
import {
  createDeliveryEventDraft,
  type DeliveryEventDraftInput,
} from '../contracts/event-factory.js';
import { DeliveryEventType } from '../contracts/events.js';
import type { ExternalDeliveryAdapter } from '../contracts/config.js';
import type { DeliveryIntentView } from '../contracts/views.js';
import { DeliveryResultKind, DeliveryState } from '../contracts/vocabulary.js';

export interface DeliveryServiceDependencies {
  readonly journal: EventJournal;
  readonly intents: () => Promise<readonly DeliveryIntentView[]>;
  readonly resource: DeliveryResourceLookup;
  readonly adapter: (name: string) => ExternalDeliveryAdapter;
  readonly now: () => string;
}
export type DeliveryResourceLookup = (
  resourceId: string,
) => Promise<{ readonly resourceId: string; readonly adapter: string } | null>;
export class DeliveryService {
  constructor(private readonly dependencies: DeliveryServiceDependencies) {}
  async deliverNext(signal: AbortSignal): Promise<DeliveryIntentView | null> {
    const intent = (await this.dependencies.intents()).find(
      (item) => item.state === DeliveryState.Pending || item.state === DeliveryState.Ambiguous,
    );
    if (intent === undefined) return null;
    const resource = await this.dependencies.resource(intent.resourceId);
    if (resource === null) throw new Error(`Delivery resource not found: ${intent.resourceId}`);
    const adapter = this.dependencies.adapter(resource.adapter);
    const occurrence: DeliveryOccurrence = { ordinal: intent.occurrenceOrdinal + 1 };
    if (intent.state === DeliveryState.Ambiguous || intent.attempts > 0) {
      const reconciled = await adapter.reconcile(
        intent.reconciliationKey ?? intent.intentEventId,
        signal,
      );
      await this.append(this.reconciled(intent, occurrence, reconciled));
      if (reconciled.kind !== DeliveryResultKind.NotFound) return intent;
    }
    await this.append(this.attemptStarted(intent, occurrence));
    const result = await adapter.deliver(intent, signal);
    switch (result.kind) {
      case DeliveryResultKind.Confirmed:
        await this.append(this.confirmed(intent, occurrence, result.externalId));
        break;
      case DeliveryResultKind.Failed:
        await this.append(this.failed(intent, occurrence, result.code, result.message));
        break;
      case DeliveryResultKind.Ambiguous:
        await this.append(this.ambiguous(intent, occurrence, result.reconciliationKey));
        break;
    }
    return intent;
  }
  private async append(draft: DeliveryEventDraftInput): Promise<void> {
    const sequence = (await this.dependencies.journal.readStream(draft.stream)).length;
    await this.dependencies.journal.append(draft.stream, sequence, [
      createDeliveryEventDraft(draft),
    ]);
  }
  private metadata(
    intent: DeliveryIntentView,
    occurrence: DeliveryOccurrence,
    eventType: DeliveryEventDraftInput['eventType'],
  ) {
    return {
      eventId: `${intent.intentEventId}:${eventType}:${occurrence.ordinal}`,
      occurredAt: this.dependencies.now(),
      correlationId: intent.intentEventId,
      causationId: intent.intentEventId,
      actor: { kind: EventActorKind.System, id: IntegrationStreamKind.Delivery },
      source: { kind: EventSourceKind.Internal, id: IntegrationStreamKind.Delivery },
      stream: deliveryStream(intent.intentEventId),
    };
  }
  private correlation(intent: DeliveryIntentView, occurrence: DeliveryOccurrence) {
    return {
      intentEventId: intent.intentEventId,
      intentGlobalPosition: intent.globalPosition,
      workflowInstanceId: intent.workflowInstanceId,
      activationId: intent.activationId,
      occurrenceOrdinal: occurrence.ordinal,
    };
  }
  private attemptStarted(
    intent: DeliveryIntentView,
    occurrence: DeliveryOccurrence,
  ): DeliveryEventDraftInput {
    return {
      ...this.metadata(intent, occurrence, DeliveryEventType.AttemptStarted),
      eventType: DeliveryEventType.AttemptStarted,
      payload: this.correlation(intent, occurrence),
    };
  }
  private confirmed(
    intent: DeliveryIntentView,
    occurrence: DeliveryOccurrence,
    externalId: string,
  ): DeliveryEventDraftInput {
    return {
      ...this.metadata(intent, occurrence, DeliveryEventType.Confirmed),
      eventType: DeliveryEventType.Confirmed,
      payload: { ...this.correlation(intent, occurrence), externalId },
    };
  }
  private failed(
    intent: DeliveryIntentView,
    occurrence: DeliveryOccurrence,
    code: string,
    message: string,
  ): DeliveryEventDraftInput {
    return {
      ...this.metadata(intent, occurrence, DeliveryEventType.Failed),
      eventType: DeliveryEventType.Failed,
      payload: { ...this.correlation(intent, occurrence), code, message },
    };
  }
  private ambiguous(
    intent: DeliveryIntentView,
    occurrence: DeliveryOccurrence,
    reconciliationKey: string,
  ): DeliveryEventDraftInput {
    return {
      ...this.metadata(intent, occurrence, DeliveryEventType.Ambiguous),
      eventType: DeliveryEventType.Ambiguous,
      payload: { ...this.correlation(intent, occurrence), reconciliationKey },
    };
  }
  private reconciled(
    intent: DeliveryIntentView,
    occurrence: DeliveryOccurrence,
    result: Awaited<ReturnType<ExternalDeliveryAdapter['reconcile']>>,
  ): DeliveryEventDraftInput {
    const metadata = this.metadata(intent, occurrence, DeliveryEventType.Reconciled);
    const correlation = this.correlation(intent, occurrence);
    switch (result.kind) {
      case DeliveryResultKind.Confirmed:
        return {
          ...metadata,
          eventType: DeliveryEventType.Reconciled,
          payload: { ...correlation, result: result.kind, externalId: result.externalId },
        };
      case DeliveryResultKind.NotFound:
      case DeliveryResultKind.Unknown:
        return {
          ...metadata,
          eventType: DeliveryEventType.Reconciled,
          payload: { ...correlation, result: result.kind },
        };
    }
  }
}

interface DeliveryOccurrence {
  readonly ordinal: number;
}
