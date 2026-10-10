import type { Runner } from '../../contracts/runner.js';

export class NoEligibleRunnerError extends Error {
  constructor(public readonly runnerPool: string) {
    super(
      `Execution runner pool ${runnerPool} has no eligible runner: all candidates are ineligible`,
    );
    this.name = 'NoEligibleRunnerError';
  }
}

export class RunnerRegistry {
  constructor(
    private readonly runnerPools: Readonly<Record<string, readonly string[]>>,
    private readonly runners: Readonly<Record<string, Runner>>,
  ) {}

  resolve(
    runnerPool: string,
    ineligible: ReadonlySet<string> = new Set(),
    requirements: { readonly ephemeralMcp?: boolean } = {},
  ): { readonly name: string; readonly runner: Runner } {
    const candidates = this.runnerPools[runnerPool];
    if (candidates === undefined)
      throw new Error(`Execution runner pool ${runnerPool} has no runner`);
    return selectEligibleCandidate(runnerPool, candidates, this.runners, ineligible, requirements);
  }
}

// Falls sideways to the next candidate on quota ineligibility; never a different runner pool.
function selectEligibleCandidate(
  runnerPool: string,
  candidates: readonly string[],
  runners: Readonly<Record<string, Runner>>,
  ineligible: ReadonlySet<string>,
  requirements: { readonly ephemeralMcp?: boolean },
): { readonly name: string; readonly runner: Runner } {
  for (const name of candidates) {
    if (ineligible.has(name)) continue;
    const runner = runners[name];
    if (runner === undefined) throw new Error(`Runner ${name} is not registered`);
    if (requirements.ephemeralMcp === true && runner.supportsEphemeralMcp !== true) continue;
    return { name, runner };
  }
  throw new NoEligibleRunnerError(runnerPool);
}
