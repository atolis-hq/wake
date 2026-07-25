import type { Clock } from '../lib/clock.js';
import { maxConfiguredRunnerTimeoutMs } from '../domain/runner-routing.js';
import type { RunRecord, WakeConfig } from '../domain/types.js';
import { isRunLeaseExpired } from './run-lease.js';
import { processIdentityMatches } from '../lib/process-identity.js';
import type { ResourceIndex } from './contracts.js';
import { createOutbox } from './outbox.js';
import { createProjectionUpdater } from './projection-updater.js';
import { createStaleRunReconciler } from './stale-run-reconciler.js';

type StateStore = ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;

export function createActiveRunRecovery(deps: {
  clock: Clock;
  config: WakeConfig;
  stateStore: StateStore;
  resourceIndex: ResourceIndex;
}) {
  const projectionUpdater = createProjectionUpdater({
    stateStore: deps.stateStore,
    resourceIndex: deps.resourceIndex,
    config: deps.config,
  });
  const { deliverOutboundEvent } = createOutbox({
    clock: deps.clock,
    stateStore: deps.stateStore,
    projectionUpdater,
  });

  async function isRunningRecordActive(record: RunRecord, now: Date): Promise<boolean> {
    if (record.lease !== undefined && !isRunLeaseExpired(record, now)) {
      return true;
    }

    return (
      processIdentityMatches({
        pid: record.agentPid,
        processStartedAt: record.agentProcessStartedAt,
      }) ||
      processIdentityMatches({
        pid: record.workerPid,
        processStartedAt: record.workerProcessStartedAt,
      })
    );
  }

  const { reconcileStaleRunningRecords } = createStaleRunReconciler({
    config: deps.config,
    stateStore: deps.stateStore,
    projectionUpdater,
    runnerTimeoutMs: () => maxConfiguredRunnerTimeoutMs(deps.config),
    isRunningRecordActive,
    deliverOutboundEvent,
  });

  return {
    recoverActiveRuns() {
      return reconcileStaleRunningRecords(deps.clock.now());
    },
  };
}
