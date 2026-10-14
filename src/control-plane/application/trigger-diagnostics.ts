import type { ProcessorStateStore } from '@atolis-hq/eventing';
import type { TriggerConfig } from '../contracts/config.js';
import type { TriggerSource } from '../contracts/events.js';
import {
  TriggerSkipReason,
  maximumTriggerDiagnostics,
  triggerDiagnosticsSchema,
  type TriggerSkipReason as SkipReason,
} from '../contracts/trigger-diagnostics.js';
import type { TriggerView } from './trigger-projection.js';

interface Dependencies {
  readonly state: ProcessorStateStore;
  readonly now: () => string;
  readonly isDispatchPaused: () => Promise<boolean>;
  readonly capacityAvailable: (config: TriggerConfig) => Promise<boolean>;
}

/** Diagnostic writes never emit trigger sources or retain an unbounded occurrence history. */
export class TriggerDiagnostics {
  constructor(
    private readonly dependencies: Dependencies,
    private readonly consumer: string,
  ) {}

  async get() {
    const stored = await this.dependencies.state.read(this.consumer, 'skip-diagnostics');
    return stored === null ? [] : triggerDiagnosticsSchema.parse(stored.value);
  }

  async record(triggerId: string, source: TriggerSource, reason: SkipReason) {
    const previous = await this.get();
    await this.dependencies.state.write({
      consumer: this.consumer,
      key: 'skip-diagnostics',
      value: [
        ...previous.filter((entry) => entry.triggerId !== triggerId),
        { triggerId, source, reason, occurredAt: this.dependencies.now() },
      ].slice(-maximumTriggerDiagnostics),
    });
  }

  async ineligibleReason(
    view: TriggerView,
    id: string,
    config: TriggerConfig | undefined,
    configured: boolean,
    active = false,
    manual = false,
  ): Promise<SkipReason | undefined> {
    if (!manual && view.pauses[id] !== undefined) return TriggerSkipReason.Paused;
    if (config === undefined || !configured) return TriggerSkipReason.Removed;
    if (await this.dependencies.isDispatchPaused()) return TriggerSkipReason.DispatchPaused;
    if (
      !active &&
      requiresCapacity(config, manual) &&
      !(await this.dependencies.capacityAvailable(config))
    )
      return TriggerSkipReason.Capacity;
    return undefined;
  }
}

function requiresCapacity(config: TriggerConfig, manual: boolean): boolean {
  return manual || config.when?.capacityAvailable === true;
}
