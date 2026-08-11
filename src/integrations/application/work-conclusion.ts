import { WorkStatus, type WorkItemId, type WorkService } from '../../work/index.js';
import { ExternalWorkOutcome } from '../contracts/outcome-vocabulary.js';
import type { WorkConclusion } from '../contracts/provider.js';

export interface WorkConclusionServices {
  readonly work: WorkService;
  readonly conclusion: WorkConclusion;
}

export interface ConcludeObservedWork {
  readonly workItemId: WorkItemId;
  readonly outcome: ExternalWorkOutcome;
  readonly reason: string;
}

// Mirrors work-admission.ts's shared, adapter-neutral seam: an adapter
// translator calls this once it observes an external resource's terminal
// outcome. Self-idempotent — a duplicate or replayed observation, or Wake's
// own close echoing back through the next poll, is a safe no-op because it
// checks current WorkItem state rather than relying on WorkService's
// throw-on-non-Open guard.
export async function concludeObservedWork(
  services: WorkConclusionServices,
  input: ConcludeObservedWork,
): Promise<void> {
  const current = await services.work.get(input.workItemId);
  if (current === null || current.state !== WorkStatus.Open) return;
  if (input.outcome === ExternalWorkOutcome.Completed) {
    await services.conclusion.closeWork(input.workItemId, input.reason);
  } else {
    await services.conclusion.cancelWork(input.workItemId, input.reason);
  }
}
