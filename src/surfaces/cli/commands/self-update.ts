export interface SelfUpdateDependencies {
  readonly tag: string;
  readonly readLedger: () => Promise<string | null>;
  readonly writeLedger: (tag: string) => Promise<void>;
  readonly update: (tag: string) => Promise<void>;
  readonly force?: boolean;
  readonly health?: () => Promise<boolean>;
  readonly rollback?: (priorTag: string) => Promise<void>;
}

/** Updates application files only; journal and projection ownership stay outside this command. */
export async function runSelfUpdate(input: SelfUpdateDependencies): Promise<boolean> {
  if (!input.force && (await input.readLedger()) === input.tag) return false;
  const priorTag = await input.readLedger();
  await input.update(input.tag);
  if (input.health !== undefined && !(await input.health())) {
    if (priorTag !== null && input.rollback !== undefined) await input.rollback(priorTag);
    throw new Error('Update ' + input.tag + ' failed health verification');
  }
  await input.writeLedger(input.tag);
  return true;
}

/** Runs update checks resiliently; the injected wait boundary owns shutdown. */
export async function runSelfUpdateLoop(
  input: SelfUpdateDependencies,
  wait: () => Promise<void>,
): Promise<never> {
  for (;;) {
    try {
      await runSelfUpdate(input);
    } catch {
      // A failed update is already rolled back when possible; the resident host retries later.
    }
    await wait();
  }
}

/** Re-discovers the source tag per iteration so a resident updater does not retain stale version state. */
export async function runSelfUpdateLatestLoop(
  updateLatest: () => Promise<unknown>,
  wait: () => Promise<void>,
): Promise<never> {
  for (;;) {
    try {
      await updateLatest();
    } catch {
      // Update failures are isolated to this iteration; the wait boundary controls retry cadence and shutdown.
    }
    await wait();
  }
}
