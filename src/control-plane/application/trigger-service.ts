import type { CommandContext, EventEnvelope } from '@atolis-hq/eventing';
import type { TriggerConfig } from '../contracts/config.js';
import { artifactContextCoordinationKey } from '../contracts/config.js';
import {
  ControlEventType,
  TriggerRequestDisposition,
  TriggerSourceKind,
  type ManualTriggerOutcome,
  type TriggerSource,
} from '../contracts/events.js';
import { TriggerSkipReason, type TriggerSkipDiagnostic } from '../contracts/trigger-diagnostics.js';
import { CronTriggerPolicy } from '../domain/cron-trigger-policy.js';
import { TriggerDiagnostics } from './trigger-diagnostics.js';
import {
  appendTriggerFact,
  hasTriggerRequest,
  sourceIdentity,
  type TriggerFactInput,
} from './trigger-facts.js';
import { requestManualTrigger } from './trigger-manual-request.js';
import { advancePendingTriggers } from './trigger-pending.js';
import { maximumTriggerSources, type TriggerView } from './trigger-projection.js';
import { recoverTriggerInvocation } from './trigger-recovery.js';
import { hasActiveInvocation, isOwnScopeSource } from './trigger-rules.js';
import type { TriggerServiceDependencies } from './trigger-service-ports.js';
import { TriggerSourceCursor } from './trigger-source-cursor.js';
import { TriggerStateReader } from './trigger-state-reader.js';

export type { TriggerServiceDependencies } from './trigger-service-ports.js';

export type { TriggerCheckpointStore } from './trigger-source-cursor.js';

export type TriggerInspectionView = TriggerView & {
  readonly diagnostics: readonly TriggerSkipDiagnostic[];
};

export const triggerCriticalSectionConsumer = 'control-plane:trigger-coordination';

/** Requests and claims are journal facts; the cron cursor is processor recovery state. */
export class TriggerService {
  private readonly policy = new CronTriggerPolicy();
  private readonly reader: TriggerStateReader;
  private readonly sourceCursor: TriggerSourceCursor;
  private readonly diagnostics: TriggerDiagnostics;

  constructor(private readonly dependencies: TriggerServiceDependencies) {
    this.diagnostics = new TriggerDiagnostics(dependencies, triggerCriticalSectionConsumer);
    this.reader = new TriggerStateReader(dependencies.journal);
    this.sourceCursor = new TriggerSourceCursor(dependencies);
  }

  async get(): Promise<TriggerInspectionView> {
    return this.serialise(async () => ({
      ...(await this.reader.get()),
      invocations: await this.dependencies.history(),
      diagnostics: await this.diagnostics.get(),
    }));
  }

  async reconcile(context: CommandContext): Promise<void> {
    await this.serialise(async () => {
      await this.recover(context);
      await this.advanceCoalesced(context);
    });
  }

  async pause(triggerId: string, reason: string, context: CommandContext): Promise<void> {
    await this.serialise(async () => {
      await this.reader.get();
      await this.emit(
        {
          eventType: ControlEventType.TriggerPaused,
          payload: { triggerId, reason, coordinationKey: this.commandKey(triggerId) },
        },
        context,
        `trigger:pause:${triggerId}:${context.commandId}`,
      );
    });
  }

  async resume(triggerId: string, context: CommandContext): Promise<void> {
    await this.serialise(async () => {
      await this.reader.get();
      await this.emit(
        {
          eventType: ControlEventType.TriggerResumed,
          payload: { triggerId, coordinationKey: this.commandKey(triggerId) },
        },
        context,
        `trigger:resume:${triggerId}:${context.commandId}`,
      );
    });
  }

  async requestManual(triggerId: string, context: CommandContext): Promise<ManualTriggerOutcome> {
    return this.serialise(() =>
      requestManualTrigger(
        {
          dependencies: this.dependencies,
          diagnostics: this.diagnostics,
          config: this.configured(triggerId),
          coordinationKey: () => this.commandKey(triggerId),
          view: () => this.reader.get(),
          recover: (command) => this.recover(command),
          advance: (command) => this.advanceCoalesced(command),
          emit: (input, command, id) => this.emit(input, command, id),
        },
        triggerId,
        context,
      ),
    );
  }

  async run(config: TriggerConfig, context: CommandContext): Promise<readonly string[]> {
    return this.serialise(async () => {
      const accepted: string[] = [];
      // Recovery finishes committed claims, even when their definition was removed or paused.
      await this.recover(context);
      if (config.on.cron !== undefined) {
        const checkpoint = await this.dependencies.checkpoint.load(config.id);
        for (const slot of this.policy.elapsedSlots(
          { id: config.id, cron: config.on.cron },
          this.dependencies.now(),
          checkpoint,
          64,
        )) {
          if (await this.request(config, { kind: TriggerSourceKind.Cron, slot: slot.at }, context))
            accepted.push(slot.identity);
          await this.dependencies.checkpoint.save(config.id, slot.at);
        }
      }
      await this.advanceCoalesced(context);
      return accepted;
    });
  }

  async start(
    config: TriggerConfig,
    source: Exclude<TriggerSource, { kind: typeof TriggerSourceKind.Manual }>,
    context: CommandContext,
    event?: EventEnvelope,
  ): Promise<boolean> {
    return this.serialise(async () => {
      await this.recover(context);
      const accepted = await this.request(config, source, context, event);
      if (source.kind === TriggerSourceKind.Cron) {
        const previous = await this.dependencies.checkpoint.load(config.id);
        if (previous === null || Date.parse(source.slot) > Date.parse(previous))
          await this.dependencies.checkpoint.save(config.id, source.slot);
      }
      await this.advanceCoalesced(context);
      return accepted;
    });
  }

  private serialise<T>(operation: () => Promise<T>): Promise<T> {
    return this.dependencies.serialise(
      triggerCriticalSectionConsumer,
      new AbortController().signal,
      operation,
    );
  }

  private key(config: TriggerConfig): string {
    return config.contextScope === undefined
      ? (this.dependencies.coordinationKey?.(config) ?? config.id)
      : artifactContextCoordinationKey(config.contextScope);
  }

  private commandKey(triggerId: string): string {
    const config = this.configured(triggerId);
    return config === undefined
      ? (this.reader.current.requests.find((request) => request.triggerId === triggerId)
          ?.coordinationKey ?? triggerId)
      : this.key(config);
  }

  private configured(id: string): TriggerConfig | undefined {
    return this.dependencies.configurations().find((config) => config.id === id);
  }

  private async emit(
    input: TriggerFactInput,
    context: CommandContext,
    eventId: string,
  ): Promise<void> {
    await this.reader.get();
    await appendTriggerFact(
      this.dependencies.journal,
      this.dependencies.now(),
      input,
      context,
      eventId,
      input.eventType === ControlEventType.TriggerRequestRecorded
        ? this.reader.sequence(input.payload.coordinationKey)
        : undefined,
    );
  }

  private async request(
    config: TriggerConfig,
    source: TriggerSource,
    context: CommandContext,
    event?: EventEnvelope,
  ): Promise<boolean> {
    const view = await this.reader.get();
    if (await this.sourceCursor.isConsumed(config.id, source, event)) return false;
    const duplicate = hasTriggerRequest(view.requests, config.id, source);
    const coordinationKey = this.key(config);
    // The reactor checkpoint consumes suppressed sources. Emitting another trigger request
    // here could itself become a source when subscribed to Control Plane events.
    if (duplicate) {
      await this.sourceCursor.consume(config.id, source, event);
      return false;
    }
    if (
      await isOwnScopeSource(view, { triggerId: config.id, coordinationKey }, event, {
        keyOf: (id) => {
          const other = this.configured(id);
          return other === undefined ? undefined : this.key(other);
        },
        sourceWorkItem: this.dependencies.sourceWorkItem,
        invocationScope: this.dependencies.invocationScope,
      })
    ) {
      await this.diagnostics.record(config.id, source, TriggerSkipReason.OwnScope);
      await this.sourceCursor.consume(config.id, source, event);
      return false;
    }
    const reason = await this.diagnostics.ineligibleReason(
      view,
      config.id,
      config,
      this.configured(config.id) !== undefined,
      hasActiveInvocation(view, coordinationKey),
    );
    const eligible = reason === undefined;
    if (reason !== undefined) await this.diagnostics.record(config.id, source, reason);
    else if ((view.coalesced[coordinationKey]?.sources.length ?? 0) >= maximumTriggerSources)
      await this.diagnostics.record(config.id, source, TriggerSkipReason.PendingLimit);
    if (eligible && (view.coalesced[coordinationKey]?.sources.length ?? 0) < maximumTriggerSources)
      await this.emit(
        {
          eventType: ControlEventType.TriggerRequestRecorded,
          payload: {
            triggerId: config.id,
            coordinationKey,
            source,
            disposition: TriggerRequestDisposition.Coalesced,
          },
        },
        context,
        `trigger:request:${config.id}:${sourceIdentity(source)}`,
      );
    await this.sourceCursor.consume(config.id, source, event);
    return eligible;
  }

  private async advanceCoalesced(context: CommandContext): Promise<void> {
    await advancePendingTriggers(
      {
        dependencies: this.dependencies,
        diagnostics: this.diagnostics,
        view: () => this.reader.get(),
        configured: (id) => this.configured(id),
        emit: (input, command, id) => this.emit(input, command, id),
        recover: (command) => this.recover(command),
      },
      context,
    );
  }

  private async recover(context: CommandContext): Promise<void> {
    for (const invocation of (await this.reader.get()).invocations) {
      if (invocation.result === undefined)
        await recoverTriggerInvocation(
          {
            work: this.dependencies.work,
            orchestration: this.dependencies.orchestration,
            emit: (input, command, id) => this.emit(input, command, id),
          },
          invocation,
          context,
        );
    }
  }
}
