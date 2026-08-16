/* eslint-disable complexity */
import {
  EventActorKind,
  EventSourceKind,
  type CommandContext,
  type EventJournal,
} from '../../../kernel/index.js';
import { deliveryStream, IntegrationStreamKind } from '../../contracts/streams.js';
import type { ExternalDeliveryAdapter } from '../contracts/config.js';
import {
  createDeliveryEventDraft,
  type DeliveryEventDraftInput,
} from '../contracts/event-factory.js';
import { DeliveryEventType } from '../contracts/events.js';
import type { DeliveryIntentView } from '../contracts/views.js';
import { DeliveryResultKind, DeliveryState } from '../contracts/vocabulary.js';

export interface DeliveryServiceDependencies {
  readonly journal: EventJournal;
  readonly intents: () => Promise<readonly DeliveryIntentView[]>;
  readonly resource: DeliveryResourceLookup;
  /** Returns null when the Resource's provider is unavailable in this runtime. */
  readonly adapter: (name: string) => ExternalDeliveryAdapter | null;
  readonly now: () => string;
  readonly maxAmbiguityReconciliationAttempts?: number;
}

export type DeliveryResourceLookup = (
  resourceId: string,
) => Promise<{ readonly resourceId: string; readonly adapter: string } | null>;

export type DeliveryResolution =
  | { readonly kind: typeof DeliveryResultKind.Confirmed; readonly externalId: string }
  | {
      readonly kind: typeof DeliveryResultKind.Failed;
      readonly code: string;
      readonly message: string;
    };

export class DeliveryService {
  constructor(private readonly dependencies: DeliveryServiceDependencies) {}
  async resolveDelivery(
    intentId: string,
    resolution: DeliveryResolution,
    context: CommandContext,
  ): Promise<DeliveryIntentView> {
    if (context.actor.kind !== EventActorKind.Operator)
      throw new Error('Delivery resolution requires an operator actor');
    const intent = (await this.dependencies.intents()).find(
      (item) => item.intentEventId === intentId,
    );
    if (intent === undefined) throw new Error(`Delivery intent ${intentId} does not exist`);
    if (intent.state !== DeliveryState.Ambiguous || intent.escalation === undefined)
      throw new Error(`Delivery intent ${intentId} is not escalated`);
    const occurrence: DeliveryOccurrence = { ordinal: intent.occurrenceOrdinal + 1 };
    const metadata = {
      eventId: `${context.commandId}:delivery-resolution`,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
      actor: context.actor,
      source: { kind: EventSourceKind.Internal, id: IntegrationStreamKind.Delivery },
      stream: deliveryStream(intent.intentEventId),
    };
    const draft: DeliveryEventDraftInput =
      resolution.kind === DeliveryResultKind.Confirmed
        ? {
            ...metadata,
            eventType: DeliveryEventType.Confirmed,
            payload: { ...this.correlation(intent, occurrence), externalId: resolution.externalId },
          }
        : {
            ...metadata,
            eventType: DeliveryEventType.Failed,
            payload: {
              ...this.correlation(intent, occurrence),
              code: resolution.code,
              message: resolution.message,
            },
          };
    try {
      await this.append(draft);
    } catch {
      // A concurrent operator or automatic confirmation wins; return the projected state.
    }
    return (
      (await this.dependencies.intents()).find((item) => item.intentEventId === intentId) ?? intent
    );
  }

  async deliverNext(signal: AbortSignal): Promise<DeliveryIntentView | null> {
    const intent = (await this.dependencies.intents()).find(
      (item) =>
        (item.state === DeliveryState.Pending || item.state === DeliveryState.Ambiguous) &&
        item.escalation === undefined,
    );
    if (intent === undefined) return null;
    const resource = await this.dependencies.resource(intent.resourceId);
    if (resource === null) throw new Error(`Delivery resource not found: ${intent.resourceId}`);
    const occurrence: DeliveryOccurrence = { ordinal: intent.occurrenceOrdinal + 1 };
    const adapter = this.dependencies.adapter(resource.adapter);
    if (adapter === null) {
      await this.append(
        this.failed(
          intent,
          occurrence,
          'provider-unavailable',
          `Delivery provider ${resource.adapter} is unavailable`,
        ),
      );
      return intent;
    }
    if (intent.state === DeliveryState.Ambiguous || intent.attempts > 0) {
      const reconciled = await adapter.reconcile(
        intent,
        intent.reconciliationKey ?? intent.intentEventId,
        signal,
      );
      await this.append(this.reconciled(intent, occurrence, reconciled));
      if (reconciled.kind === DeliveryResultKind.Unknown) {
        const count = (intent.reconciliationAttempts ?? 0) + 1;
        if (count >= (this.dependencies.maxAmbiguityReconciliationAttempts ?? 3))
          await this.append(this.escalated(intent, occurrence, count));
        return intent;
      }
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

  private escalated(
    intent: DeliveryIntentView,
    occurrence: DeliveryOccurrence,
    attempt: number,
  ): DeliveryEventDraftInput {
    return {
      ...this.metadata(intent, occurrence, DeliveryEventType.Escalated),
      eventType: DeliveryEventType.Escalated,
      payload: {
        ...this.correlation(intent, occurrence),
        reason: `delivery-ambiguous-after-${attempt}-attempts`,
      },
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
