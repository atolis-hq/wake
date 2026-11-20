import type { EventJournal } from '@atolis-hq/eventing';
import { onTestFinished } from 'vitest';
import { isActiveRunStatus, RunRepository } from '../../src/execution/index.js';

/** Call after dispatch; wait for the registered Runs, bounded by the enclosing test deadline. */
export function createRunSettlement(journal: EventJournal) {
  const runs = new RunRepository(journal);
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  return async (scope?: { workflowId: string } | { runId: string }) => {
    const registered = new Set(
      scope !== undefined && 'runId' in scope
        ? [scope.runId]
        : (await runs.list())
            .filter((run) => scope === undefined || run.workflowInstanceId === scope.workflowId)
            .map((run) => run.runId),
    );
    for (;;) {
      controller.signal.throwIfAborted();
      // Capture before reading so an append during the read cannot be missed.
      const position = await journal.latestGlobalPosition();
      const observed = (await runs.list()).filter((run) => registered.has(run.runId));
      if (
        observed.length === registered.size &&
        observed.every((run) => !isActiveRunStatus(run.status))
      )
        return observed;
      await journal.waitForEventsAfter(position, controller.signal, 60_000);
    }
  };
}
