import { rename, writeFile } from 'node:fs/promises';
import type { ExternalDeliveryAdapter } from '../delivery/contracts/config.js';
import type { DeliveryIntentView } from '../delivery/contracts/views.js';
import { DeliveryResultKind } from '../delivery/contracts/vocabulary.js';
import type { EventId } from '../../kernel/index.js';

export class DurableFakeDeliveryProvider implements ExternalDeliveryAdapter {
  readonly effects: Map<string, string>;
  deliveryCalls = 0;
  private ambiguous = new Map<string, EventId>();
  private crashAfterEffect = false;

  constructor(options: DurableFakeDeliveryProviderOptions = {}) {
    this.effects = new Map(Object.entries(options.effects ?? {}));
    this.effectsFile = options.effectsFile;
  }

  private readonly effectsFile: string | undefined;

  crashAfterNextEffect(): void {
    this.crashAfterEffect = true;
  }

  async deliver(intent: DeliveryIntentView) {
    this.deliveryCalls += 1;
    const existing = this.effects.get(intent.intentEventId);
    if (existing !== undefined) return { kind: DeliveryResultKind.Confirmed, externalId: existing };
    const externalId = `external-${this.effects.size + 1}`;
    this.effects.set(intent.intentEventId, externalId);
    await this.persistEffects();
    if (this.crashAfterEffect) {
      this.crashAfterEffect = false;
      throw new Error('simulated provider crash after accepted effect');
    }
    return { kind: DeliveryResultKind.Confirmed, externalId };
  }

  rememberAmbiguous(intentEventId: EventId, reconciliationKey: string): void {
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

  private async persistEffects(): Promise<void> {
    if (this.effectsFile === undefined) return;
    const temporary = `${this.effectsFile}.next`;
    const body = `${JSON.stringify(Object.fromEntries(this.effects), null, 2)}\n`;
    await writeFile(temporary, body);
    await rename(temporary, this.effectsFile);
  }
}

export interface DurableFakeDeliveryProviderOptions {
  readonly effects?: Readonly<Record<string, string>>;
  readonly effectsFile?: string;
}
