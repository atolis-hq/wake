import type { Clock } from '../../kernel/index.js';
import type { ResourceService } from '../../resources/index.js';
import type {
  ActivationSchedulerDependencies,
  ExecutionPort,
  OrchestrationPort,
} from './activation-scheduler-ports.js';
import { createActivationScheduler } from './activation-scheduler.js';

/** Compatibility facade for callers that still use the former Advancement name. */
export function createAdvanceOnce(
  orchestration: OrchestrationPort,
  execution: ExecutionPort,
  resources: ResourceService,
  clock: Clock,
  dependencies: ActivationSchedulerDependencies,
) {
  const scheduler = createActivationScheduler(
    orchestration,
    execution,
    resources,
    clock,
    dependencies,
  );
  return (options: Parameters<typeof scheduler.runOnce>[0]) => scheduler.runOnce(options);
}
