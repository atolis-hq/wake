export class FakeExternalSink {
  readonly delivered: unknown[] = [];

  async deliver(effect: unknown): Promise<void> {
    this.delivered.push(effect);
  }
}
