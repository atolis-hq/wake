export class InjectedFaultError extends Error {
  constructor(readonly faultName: string) {
    super(`Injected fault: ${faultName}`);
  }
}

export class FaultInjector {
  private readonly armed = new Set<string>();

  failOnce(name: string): void {
    this.armed.add(name);
  }

  check(name: string): void {
    if (!this.armed.delete(name)) return;
    throw new InjectedFaultError(name);
  }
}
