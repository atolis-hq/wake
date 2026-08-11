export interface StopApplication {
  stop(): Promise<void>;
}

export interface ActiveRunWaitDependencies {
  readonly activeRunIds: () => Promise<readonly string[]>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export async function waitForActiveRuns(input: ActiveRunWaitDependencies): Promise<void> {
  const interval = input.pollIntervalMs ?? 5_000;
  const started = Date.now();
  for (;;) {
    const active = await input.activeRunIds();
    if (active.length === 0) return;
    if (input.timeoutMs !== undefined && Date.now() - started >= input.timeoutMs)
      throw new Error(`Timed out waiting for active runs: ${active.join(', ')}`);
    await input.sleep(interval);
  }
}

export const stop = (application: StopApplication) => application.stop();
