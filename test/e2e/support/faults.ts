export class InjectedFaultError extends Error {
  constructor(readonly faultName: string) {
    super(`Injected fault: ${faultName}`);
  }
}

export class FaultInjector {
  private readonly armed = new Set<string>();

  failOnce(name: string): void {
    this.armed.add(name);
  }

  isArmed(name: string): boolean {
    return this.armed.has(name);
  }

  check(name: string): void {
    if (!this.armed.delete(name)) return;
    throw new InjectedFaultError(name);
  }
}

export interface DeliveryEvidence {
  readonly acceptedEffectIds: Set<string>;
  readonly reconciledEffectIds: Set<string>;
  providerInvocations: number;
}

export function faultInjectingJournal(journal: EventJournal, faults: FaultInjector): EventJournal {
  return {
    async appendToStream(stream, expectedSequence, events) {
      faults.check('journal.appendToStream.before');
      checkEventFaults(faults, events, 'before');
      const appended = await journal.appendToStream(stream, expectedSequence, events);
      checkEventFaults(faults, events, 'after');
      faults.check('journal.appendToStream.after');
      return appended;
    },
    readStream: journal.readStream.bind(journal),
    readAll: journal.readAll.bind(journal),
    latestGlobalPosition: journal.latestGlobalPosition.bind(journal),
    waitForEventsAfter: journal.waitForEventsAfter.bind(journal),
    changeSignal: journal.changeSignal,
    ...(journal.readLatest === undefined ? {} : { readLatest: journal.readLatest.bind(journal) }),
  };
}

function checkEventFaults(
  faults: FaultInjector,
  events: readonly { readonly eventType: string }[],
  timing: 'before' | 'after',
): void {
  for (const event of events) {
    const point = eventFaultPoint(event.eventType);
    if (point !== undefined) faults.check(`${point}.${timing}`);
  }
}

function eventFaultPoint(eventType: string): string | undefined {
  switch (eventType) {
    case 'execution.run-started':
      return 'run.start';
    case 'execution.run-runner-result-reported':
      return 'run.result-append';
    case 'orchestration.activity-outcome-accepted':
      return 'workflow.outcome-acceptance';
    case 'delivery.confirmed':
      return 'delivery.confirmation-append';
    case 'orchestration.child-completion-consumed':
      return 'child.completion-consumption';
    default:
      return undefined;
  }
}

export function faultInjectingProjections(
  projections: ProjectionStore,
  faults: FaultInjector,
): ProjectionStore {
  return {
    read: projections.read.bind(projections),
    async write(projection) {
      faults.check('projection.write.before');
      await projections.write(projection);
      faults.check('projection.write.after');
    },
    list: projections.list.bind(projections),
    clear: projections.clear.bind(projections),
  };
}

export function faultInjectingCheckpoints(
  checkpoints: CheckpointStore,
  faults: FaultInjector,
): CheckpointStore {
  return {
    load: checkpoints.load.bind(checkpoints),
    async save(consumer, position) {
      faults.check('checkpoint.write.before');
      await checkpoints.save(consumer, position);
      faults.check('checkpoint.write.after');
    },
    reset: checkpoints.reset.bind(checkpoints),
  };
}

export function faultInjectingScheduleCheckpoints(
  checkpoints: ScheduleCheckpointStore,
  faults: FaultInjector,
): ScheduleCheckpointStore {
  return {
    load: checkpoints.load.bind(checkpoints),
    async save(scheduleId, slot) {
      faults.check('schedule.slot-checkpoint.before');
      await checkpoints.save(scheduleId, slot);
      faults.check('schedule.slot-checkpoint.after');
    },
  };
}

export function faultInjectingDeliveryAdapter(
  adapter: ExternalDeliveryAdapter,
  faults: FaultInjector,
  evidence?: DeliveryEvidence,
): ExternalDeliveryAdapter {
  return {
    async deliver(intent, signal) {
      faults.check('outbound.provider-acceptance.before');
      if (evidence !== undefined) evidence.providerInvocations += 1;
      const result = await adapter.deliver(intent, signal);
      if (evidence !== undefined && 'externalId' in result)
        evidence.acceptedEffectIds.add(result.externalId);
      faults.check('outbound.provider-acceptance.after');
      return result;
    },
    async reconcile(intent, reconciliationKey, signal) {
      const result = await adapter.reconcile(intent, reconciliationKey, signal);
      if (evidence !== undefined && 'externalId' in result)
        evidence.reconciledEffectIds.add(result.externalId);
      return result;
    },
  };
}
import type { CheckpointStore, EventJournal, ProjectionStore } from '@atolis-hq/eventing';
import type { ScheduleCheckpointStore } from '../../../src/control-plane/index.js';
import type { ExternalDeliveryAdapter } from '../../../src/integrations/index.js';
