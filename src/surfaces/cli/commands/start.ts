import type { HostBudget, HostResult } from '../../../control-plane/index.js';

export interface ResidentApplication {
  run(signal: AbortSignal, budget: HostBudget): Promise<HostResult>;
}

export const start = (application: ResidentApplication, signal: AbortSignal, budget: HostBudget) =>
  application.run(signal, budget);
