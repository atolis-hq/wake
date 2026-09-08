import type { Clock } from '../../kernel/index.js';
import type { ResourceService } from '../../resources/index.js';
import type { PhasedAdvanceOnce } from '../contracts/commands.js';
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
  return Object.assign(scheduler.runOnce.bind(scheduler), {
    maintain: scheduler.maintain!.bind(scheduler),
    dispatch: scheduler.dispatch!.bind(scheduler),
  }) satisfies PhasedAdvanceOnce;
}
