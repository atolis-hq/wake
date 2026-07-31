import type { ExternalDeliveryAdapter } from '../contracts/config.js';
import type { DeliveryIntentView } from '../contracts/views.js';
import { DeliveryEventType } from '../contracts/events.js';
import { DeliveryResultKind, DeliveryState } from '../contracts/vocabulary.js';

export interface DeliveryServiceDependencies {
  readonly intents: () => Promise<readonly DeliveryIntentView[]>;
  readonly resource: (
    resourceId: string,
  ) => Promise<{ readonly resourceId: string; readonly adapter: string } | null>;
  readonly adapter: (name: string) => ExternalDeliveryAdapter;
  readonly append: (event: {
    readonly type: string;
    readonly intentEventId: string;
    readonly [key: string]: unknown;
  }) => Promise<void>;
}
export class DeliveryService {
  constructor(private readonly dependencies: DeliveryServiceDependencies) {}
  async deliverNext(signal: AbortSignal): Promise<DeliveryIntentView | null> {
    const intent = (await this.dependencies.intents()).find(
      (candidate) =>
        candidate.state === DeliveryState.Pending || candidate.state === DeliveryState.Ambiguous,
    );
    if (intent === undefined) return null;
    const resource = await this.dependencies.resource(intent.resourceId);
    if (resource === null) throw new Error(`Delivery resource not found: ${intent.resourceId}`);
    const adapter = this.dependencies.adapter(resource.adapter);
    if (intent.state === DeliveryState.Ambiguous) {
      const reconciled = await adapter.reconcile(intent.reconciliationKey!, signal);
      await this.dependencies.append({
        type: DeliveryEventType.Reconciled,
        intentEventId: intent.intentEventId,
        result: reconciled.kind,
        ...(reconciled.kind === DeliveryResultKind.Confirmed
          ? { externalId: reconciled.externalId }
          : {}),
      });
      if (reconciled.kind !== DeliveryResultKind.NotFound) return intent;
    }
    await this.dependencies.append({
      type: DeliveryEventType.AttemptStarted,
      intentEventId: intent.intentEventId,
    });
    const result = await adapter.deliver(intent, signal);
    const eventType =
      result.kind === DeliveryResultKind.Confirmed
        ? DeliveryEventType.Confirmed
        : result.kind === DeliveryResultKind.Failed
          ? DeliveryEventType.Failed
          : DeliveryEventType.Ambiguous;
    await this.dependencies.append({
      type: eventType,
      intentEventId: intent.intentEventId,
      ...result,
    });
    return intent;
  }
}
