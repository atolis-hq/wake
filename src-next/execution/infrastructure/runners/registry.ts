import type { Runner } from '../../contracts/runner.js';

export class RunnerRegistry {
  constructor(
    private readonly tiers: Readonly<Record<string, readonly string[]>>,
    private readonly runners: Readonly<Record<string, Runner>>,
  ) {}

  resolve(tier: string): Runner {
    const name = this.tiers[tier]?.[0];
    if (name === undefined) throw new Error(`Execution tier ${tier} has no runner`);
    const runner = this.runners[name];
    if (runner === undefined) throw new Error(`Runner ${name} is not registered`);
    return runner;
  }
}
