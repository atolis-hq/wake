export interface SelfUpdateDependencies {
  readonly tag: string;
  readonly readLedger: () => Promise<string | null>;
  readonly writeLedger: (tag: string) => Promise<void>;
  readonly update: (tag: string) => Promise<void>;
  readonly force?: boolean;
}

/** Updates application files only; journal and projection ownership stay outside this command. */
export async function runSelfUpdate(input: SelfUpdateDependencies): Promise<boolean> {
  if (!input.force && (await input.readLedger()) === input.tag) return false;
  await input.update(input.tag);
  await input.writeLedger(input.tag);
  return true;
}
