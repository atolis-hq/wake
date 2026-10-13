import {
  correlationId,
  EventActorKind,
  type CommandContext,
  type EventEnvelope,
  type EventJournal,
  type ProcessorRunSerialiser,
} from '@atolis-hq/eventing';
import type { IdGenerator } from '../../kernel/index.js';
import { workflowInstanceId } from '../../orchestration/index.js';
import { workItemId } from '../../work/index.js';
import type { TriggerConfig } from '../contracts/config.js';
import {
  ControlEventType,
  TriggerRequestDisposition,
  TriggerSourceKind,
  type TriggerSource,
} from '../contracts/events.js';
import { controlPlaneStream } from '../contracts/streams.js';
import { CronTriggerPolicy } from '../domain/cron-trigger-policy.js';
import { appendTriggerFact, sourceIdentity, type TriggerFactInput } from './trigger-facts.js';
import { triggerProjection, type TriggerView } from './trigger-projection.js';
import {
  exhaustedFailures,
  finishedStatus,
  hasActiveInvocation,
  isOwnScopeSource,
} from './trigger-rules.js';
import { ensureTriggerWorkflow, type TriggerWorkflowPorts } from './trigger-workflow.js';

export const triggerCriticalSectionConsumer = 'control-plane:trigger-coordination';

export interface TriggerCheckpointStore {
  load(triggerId: string): Promise<string | null>;
  save(triggerId: string, slot: string): Promise<void>;
}

export interface TriggerServiceDependencies extends TriggerWorkflowPorts {
  readonly checkpoint: TriggerCheckpointStore;
  readonly journal: EventJournal;
  readonly serialise: ProcessorRunSerialiser;
  readonly ids: IdGenerator;
  readonly configurations: () => readonly TriggerConfig[];
  readonly coordinationKey?: (config: TriggerConfig) => string;
  readonly sourceWorkItem: (event: EventEnvelope) => Promise<string | null>;
  readonly isDispatchPaused: () => Promise<boolean>;
  readonly capacityAvailable: (config: TriggerConfig) => Promise<boolean>;
  readonly now: () => string;
}

type Invocation = TriggerView['invocations'][number];

/** Requests and claims are journal facts; the cron cursor is processor recovery state. */
export class TriggerService {
  private readonly policy = new CronTriggerPolicy();

  constructor(private readonly dependencies: TriggerServiceDependencies) {}

  async get(): Promise<TriggerView> {
    return this.view();
  }

  async reconcile(context: CommandContext): Promise<void> {
    await this.serialise(async () => {
      await this.recover(context);
      await this.advanceCoalesced(context);
    });
  }

  async pause(triggerId: string, reason: string, context: CommandContext): Promise<void> {
    await this.serialise(() =>
      this.emit(
        { eventType: ControlEventType.TriggerPaused, payload: { triggerId, reason } },
        context,
        `trigger:pause:${triggerId}:${context.commandId}`,
      ),
    );
  }

  async resume(triggerId: string, context: CommandContext): Promise<void> {
    await this.serialise(() =>
      this.emit(
        { eventType: ControlEventType.TriggerResumed, payload: { triggerId } },
        context,
        `trigger:resume:${triggerId}:${context.commandId}`,
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
    source: TriggerSource,
    context: CommandContext,
    event?: EventEnvelope,
  ): Promise<boolean> {
    return this.serialise(async () => {
      await this.recover(context);
      const accepted = await this.request(config, source, context, event);
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
    return this.dependencies.coordinationKey?.(config) ?? config.id;
  }

  private async view(): Promise<TriggerView> {
    return (await this.dependencies.journal.readStream(controlPlaneStream())).reduce(
      triggerProjection.project,
      triggerProjection.initial('global'),
    );
  }

  private configured(id: string): TriggerConfig | undefined {
    return this.dependencies.configurations().find((config) => config.id === id);
  }

  private emit(input: TriggerFactInput, context: CommandContext, eventId: string): Promise<void> {
    return appendTriggerFact(
      this.dependencies.journal,
      this.dependencies.now(),
      input,
      context,
      eventId,
    );
  }

  private async request(
    config: TriggerConfig,
    source: TriggerSource,
    context: CommandContext,
    event?: EventEnvelope,
  ): Promise<boolean> {
    const view = await this.view();
    const duplicate = view.requests.some(
      (request) =>
        request.triggerId === config.id &&
        sourceIdentity(request.source) === sourceIdentity(source),
    );
    const coordinationKey = this.key(config);
    // The reactor checkpoint consumes suppressed sources. Emitting another trigger request
    // here could itself become a source when subscribed to Control Plane events.
    if (duplicate || (await this.suppressed(view, config, coordinationKey, event))) return false;
    const eligible =
      view.pauses[config.id] === undefined &&
      this.configured(config.id) !== undefined &&
      !(await this.dependencies.isDispatchPaused()) &&
      (hasActiveInvocation(view, coordinationKey) || (await this.eligible(config)));
    const disposition = eligible
      ? TriggerRequestDisposition.Coalesced
      : TriggerRequestDisposition.Skipped;
    await this.emit(
      {
        eventType: ControlEventType.TriggerRequestRecorded,
        payload: { triggerId: config.id, coordinationKey, source, disposition },
      },
      context,
      `trigger:request:${config.id}:${sourceIdentity(source)}`,
    );
    return disposition === TriggerRequestDisposition.Coalesced;
  }

  private suppressed(
    view: TriggerView,
    config: TriggerConfig,
    coordinationKey: string,
    event?: EventEnvelope,
  ): Promise<boolean> {
    return isOwnScopeSource(view, { triggerId: config.id, coordinationKey }, event, {
      keyOf: (id) => {
        const other = this.configured(id);
        return other === undefined ? undefined : this.key(other);
      },
      sourceWorkItem: this.dependencies.sourceWorkItem,
    });
  }

  private async eligible(config: TriggerConfig): Promise<boolean> {
    return (
      !(await this.dependencies.isDispatchPaused()) &&
      (config.when?.capacityAvailable !== true ||
        (await this.dependencies.capacityAvailable(config)))
    );
  }

  private async advanceCoalesced(context: CommandContext): Promise<void> {
    const view = await this.view();
    for (const request of Object.values(view.coalesced)) {
      if (hasActiveInvocation(view, request.coordinationKey)) continue;
      const config = this.configured(request.triggerId);
      const identity = `trigger:${request.triggerId}:${sourceIdentity(request.source)}`;
      if (
        config === undefined ||
        view.pauses[request.triggerId] !== undefined ||
        !(await this.eligible(config))
      ) {
        // This recorded request was reconsidered and consumed; later eligibility is not a source.
        await this.emit(
          {
            eventType: ControlEventType.TriggerRequestRecorded,
            payload: {
              triggerId: request.triggerId,
              coordinationKey: request.coordinationKey,
              source: request.source,
              disposition: TriggerRequestDisposition.Skipped,
            },
          },
          context,
          `trigger:consume:${request.triggerId}:${sourceIdentity(request.source)}`,
        );
        continue;
      }
      await this.emit(
        {
          eventType: ControlEventType.TriggerInvocationClaimed,
          payload: {
            triggerId: config.id,
            coordinationKey: request.coordinationKey,
            source: request.source,
            sources: request.sources,
            workItemId: this.dependencies.ids.next('work'),
            workflowInstanceId: `workflow-${encodeURIComponent(identity)}`,
            workflowName: config.workflow,
          },
        },
        context,
        `${identity}:claim`,
      );
      await this.recover(context);
    }
  }

  private async recover(context: CommandContext): Promise<void> {
    for (const invocation of (await this.view()).invocations) {
      if (invocation.result === undefined) await this.recoverInvocation(invocation, context);
    }
  }

  private async recoverInvocation(invocation: Invocation, context: CommandContext): Promise<void> {
    const claim = invocation.claim;
    const workflow = workflowInstanceId(claim.workflowInstanceId);
    const invocationContext: CommandContext = {
      commandId: `${workflow}:create`,
      correlationId: correlationId(workflow),
      occurredAt: invocation.claimedAt,
      actor: { kind: EventActorKind.System, id: claim.triggerId },
    };
    const instance = await ensureTriggerWorkflow(this.dependencies, claim, invocationContext);
    if (invocation.startedAt === undefined) {
      await this.emit(
        {
          eventType: ControlEventType.TriggerInvocationStarted,
          payload: {
            triggerId: claim.triggerId,
            source: claim.source,
            workItemId: workItemId(claim.workItemId),
            workflowInstanceId: workflow,
            workflowName: claim.workflowName,
          },
        },
        invocationContext,
        `${workflow}:${ControlEventType.TriggerInvocationStarted}`,
      );
    }
    if (instance === null) return;
    if (exhaustedFailures(instance)) {
      // Retrying remains an explicit workflow command; an operator must resume the trigger.
      await this.emit(
        {
          eventType: ControlEventType.TriggerPaused,
          payload: {
            triggerId: claim.triggerId,
            reason: instance.blockReason ?? 'Invocation exhausted automatic failure retries',
          },
        },
        context,
        `${workflow}:pause:${instance.acceptedOutcomes.length}`,
      );
    }
    const status = finishedStatus(instance);
    if (status === undefined) return;
    await this.emit(
      {
        eventType: ControlEventType.TriggerInvocationFinished,
        payload: {
          triggerId: claim.triggerId,
          workflowInstanceId: workflow,
          status,
          ...(instance.blockReason === undefined ? {} : { reason: instance.blockReason }),
        },
      },
      context,
      `${workflow}:finished`,
    );
  }
}
