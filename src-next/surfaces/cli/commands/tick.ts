import type { HostBudget, HostResult } from '../../../control-plane/index.js';

export interface TickApplication {
  run(budget: HostBudget): Promise<HostResult>;
}
export const tick = (application: TickApplication, budget: HostBudget) => application.run(budget);
