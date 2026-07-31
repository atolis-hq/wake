import type { ExternalDeliveryAdapter } from '../delivery/contracts/config.js';
import type { DeliveryIntentView } from '../delivery/contracts/views.js';
import { DeliveryResultKind } from '../delivery/contracts/vocabulary.js';

export class DurableFakeDeliveryProvider implements ExternalDeliveryAdapter {
  readonly effects = new Map<string, string>();
  deliveryCalls = 0;
  private ambiguous = new Map<string, string>();
  private crashAfterEffect = false;

  crashAfterNextEffect(): void {
    this.crashAfterEffect = true;
  }

  async deliver(intent: DeliveryIntentView) {
    this.deliveryCalls += 1;
    const existing = this.effects.get(intent.intentEventId);
    if (existing !== undefined) return { kind: DeliveryResultKind.Confirmed, externalId: existing };
    const externalId = `external-${this.effects.size + 1}`;
    this.effects.set(intent.intentEventId, externalId);
    if (this.crashAfterEffect) {
      this.crashAfterEffect = false;
      throw new Error('simulated provider crash after accepted effect');
    }
    return { kind: DeliveryResultKind.Confirmed, externalId };
  }

  rememberAmbiguous(intentEventId: string, reconciliationKey: string): void {
    this.ambiguous.set(reconciliationKey, intentEventId);
  }

  async reconcile(
    reconciliationKey: string,
  ): Promise<
    | { readonly kind: typeof DeliveryResultKind.Confirmed; readonly externalId: string }
    | { readonly kind: typeof DeliveryResultKind.NotFound }
  > {
    const intentEventId = this.ambiguous.get(reconciliationKey) ?? reconciliationKey;
    const externalId = this.effects.get(intentEventId);
    return externalId === undefined
      ? { kind: DeliveryResultKind.NotFound }
      : { kind: DeliveryResultKind.Confirmed, externalId };
  }
}
