export class FakeExternalSink {
  readonly delivered: unknown[] = [];
  readonly idempotencyKeys: string[] = [];

  async deliver(effect: unknown, idempotencyKey?: string): Promise<void> {
    this.delivered.push(effect);
    if (idempotencyKey !== undefined) this.idempotencyKeys.push(idempotencyKey);
  }
}
