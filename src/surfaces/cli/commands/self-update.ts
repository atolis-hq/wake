export interface SelfUpdateDependencies {
  readonly tag: string;
  readonly readLedger: () => Promise<string | null>;
  readonly writeLedger: (tag: string) => Promise<void>;
  readonly update: (tag: string) => Promise<void>;
  readonly force?: boolean;
  readonly health?: () => Promise<boolean>;
  readonly rollback?: (priorTag: string) => Promise<void>;
}

export type SelfUpdateLog = (message: string) => void;

/** Updates application files only; journal and projection ownership stay outside this command. */
export async function runSelfUpdate(input: SelfUpdateDependencies): Promise<boolean> {
  if (!input.force && (await input.readLedger()) === input.tag) return false;
  const priorTag = await input.readLedger();
  try {
    await input.update(input.tag);
  } catch (error) {
    if (priorTag !== null && input.rollback !== undefined) await input.rollback(priorTag);
    throw error;
  }
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
  log?: SelfUpdateLog,
): Promise<never> {
  for (;;) {
    try {
      const updated = await runSelfUpdate(input);
      log?.(`wake self-update: ${updated ? 'applied' : 'already current'} ${input.tag}`);
    } catch (error) {
      log?.(`wake self-update: ${formatError(error)}`);
    }
    await wait();
  }
}

/** Re-discovers the source tag per iteration so a resident updater does not retain stale version state. */
export async function runSelfUpdateLatestLoop(
  updateLatest: () => Promise<unknown>,
  wait: () => Promise<void>,
  log?: SelfUpdateLog,
): Promise<never> {
  for (;;) {
    try {
      const result = await updateLatest();
      log?.(describeLatestUpdate(result));
    } catch (error) {
      log?.(`wake self-update: ${formatError(error)}`);
    }
    await wait();
  }
}

function describeLatestUpdate(result: unknown): string {
  if (
    typeof result === 'object' &&
    result !== null &&
    'tag' in result &&
    typeof result.tag === 'string' &&
    'updated' in result &&
    typeof result.updated === 'boolean'
  )
    return `wake self-update: ${result.updated ? 'applied' : 'no eligible update'} ${result.tag}`;
  return 'wake self-update: check completed';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
