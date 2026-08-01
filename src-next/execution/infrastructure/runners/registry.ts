import type { Runner } from '../../contracts/runner.js';

export class RunnerRegistry {
  constructor(
    private readonly tiers: Readonly<Record<string, readonly string[]>>,
    private readonly runners: Readonly<Record<string, Runner>>,
  ) {}

  resolve(
    tier: string,
    ineligible: ReadonlySet<string> = new Set(),
  ): { readonly name: string; readonly runner: Runner } {
    const candidates = this.tiers[tier];
    if (candidates === undefined) throw new Error(`Execution tier ${tier} has no runner`);
    return selectEligibleCandidate(tier, candidates, this.runners, ineligible);
  }
}

// Falls sideways to the next candidate on quota ineligibility; never a different tier.
function selectEligibleCandidate(
  tier: string,
  candidates: readonly string[],
  runners: Readonly<Record<string, Runner>>,
  ineligible: ReadonlySet<string>,
): { readonly name: string; readonly runner: Runner } {
  for (const name of candidates) {
    if (ineligible.has(name)) continue;
    const runner = runners[name];
    if (runner === undefined) throw new Error(`Runner ${name} is not registered`);
    return { name, runner };
  }
  throw new Error(`Execution tier ${tier} has no eligible runner: all candidates are ineligible`);
}
