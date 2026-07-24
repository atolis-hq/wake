import type { Clock } from '../lib/clock.js';
import { readFileLockStatus } from '../lib/lock.js';
import { maxConfiguredRunnerTimeoutMs } from '../domain/runner-routing.js';
import type { WakeConfig } from '../domain/types.js';
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

  async function isRunningRecordActive(record: { startedAt: string }): Promise<boolean> {
    const lock = await readFileLockStatus(deps.stateStore.paths.runnerLockFile, {
      expectedCommandIncludes: process.argv[1] === undefined ? [] : [process.argv[1]],
    });
    if (!lock.active || lock.metadata === undefined) {
      return false;
    }

    return Date.parse(lock.metadata.acquiredAt) <= Date.parse(record.startedAt);
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
