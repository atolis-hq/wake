import type { Clock } from '../../kernel/index.js';
import { runId } from '../contracts/identifiers.js';
import type { ExecutionCancellationReason } from '../contracts/vocabulary.js';
import { RunStatus } from '../contracts/vocabulary.js';
import { confirmCancellation, requestCancellation } from './run-liveness-service.js';
import type { RunRepository } from './run-repository.js';

export async function cancelActiveRuns(
  repository: RunRepository,
  clock: Clock,
  workflowInstanceIds: readonly string[],
  reason: ExecutionCancellationReason,
  active: ReadonlyMap<string, AbortController>,
) {
  const workflowIds = new Set(workflowInstanceIds);
  const cancelled = [];
  for (const run of await repository.list()) {
    if (run.status !== RunStatus.Started || !workflowIds.has(run.workflowInstanceId)) continue;
    await requestCancellation(repository, clock, runId(run.runId), reason, active);
    cancelled.push(await confirmCancellation(repository, clock, runId(run.runId)));
  }
  return cancelled;
}
