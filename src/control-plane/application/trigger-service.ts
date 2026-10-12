import {
  correlationId,
  defineEventProcessor,
  EventActorKind,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  EventSourceKind,
  WrongExpectedSequenceError,
  type CommandContext,
  type EventEnvelope,
  type EventJournal,
} from '@atolis-hq/eventing';
import type { IdGenerator } from '../../kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
  type StartWorkflowInstance,
} from '../../orchestration/index.js';
import { workItemId, type CreateWorkItem } from '../../work/index.js';
import type { TriggerConfig } from '../contracts/config.js';
import { createControlPlaneEventData } from '../contracts/event-factory.js';
import {
  ControlEventType,
  selectControlEvent,
  TriggerSourceKind,
  type TriggerSource,
} from '../contracts/events.js';
import { controlPlaneStream, ControlStreamKind } from '../contracts/streams.js';
import { CronTriggerPolicy } from '../domain/cron-trigger-policy.js';

export interface TriggerCheckpointStore {
  load(triggerId: string): Promise<string | null>;
  save(triggerId: string, slot: string): Promise<void>;
}

export interface TriggerServiceDependencies {
  readonly checkpoint: TriggerCheckpointStore;
  readonly journal: EventJournal;
  readonly ids: IdGenerator;
  readonly work: { create(command: CreateWorkItem, context: CommandContext): Promise<unknown> };
  readonly orchestration: {
    start(command: StartWorkflowInstance, context: CommandContext): Promise<unknown>;
    get(
      id: ReturnType<typeof workflowInstanceId>,
    ): Promise<{ readonly workItemId: ReturnType<typeof workItemId> } | null>;
  };
  readonly capacityAvailable: (config: TriggerConfig) => Promise<boolean>;
  readonly now: () => string;
}

export class TriggerService {
  private readonly policy = new CronTriggerPolicy();

  constructor(private readonly dependencies: TriggerServiceDependencies) {}

  async run(config: TriggerConfig, context: CommandContext): Promise<readonly string[]> {
    if (config.on.cron === undefined) return [];
    const checkpoint = await this.dependencies.checkpoint.load(config.id);
    const slots = this.policy.elapsedSlots(
      { id: config.id, cron: config.on.cron },
      this.dependencies.now(),
      checkpoint,
    );
    const accepted: string[] = [];
    for (const slot of slots) {
      if (await this.start(config, { kind: TriggerSourceKind.Cron, slot: slot.at }, context))
        accepted.push(slot.identity);
      // A failed gate consumes the occurrence; becoming eligible is not a source.
      await this.dependencies.checkpoint.save(config.id, slot.at);
    }
    return accepted;
  }

  async start(
    config: TriggerConfig,
    source: TriggerSource,
    context: CommandContext,
  ): Promise<boolean> {
    const identity = `trigger:${config.id}:${source.kind}:${source.kind === TriggerSourceKind.Cron ? source.slot : source.eventId}`;
    const workflow = workflowInstanceId(`workflow-${encodeURIComponent(identity)}`);
    const invocationContext = {
      ...context,
      commandId: `${context.commandId}:${identity}`,
      correlationId: correlationId(identity),
    };
    const existing = await this.dependencies.orchestration.get(workflow);
    if (
      existing === null &&
      config.when?.capacityAvailable === true &&
      !(await this.dependencies.capacityAvailable(config))
    )
      return false;
    const item = existing?.workItemId ?? workItemId(this.dependencies.ids.next('work'));
    if (existing === null) {
      await this.dependencies.work.create(
        { workItemId: item, objective: `Trigger ${config.id}: workflow ${config.workflow}` },
        invocationContext,
      );
      await this.dependencies.orchestration.start(
        {
          workflowInstanceId: workflow,
          workItemId: item,
          workflowName: workflowName(config.workflow),
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
        },
        invocationContext,
      );
    }
    await this.recordInvocation(config, source, invocationContext, item, workflow);
    return true;
  }

  private async recordInvocation(
    config: TriggerConfig,
    source: TriggerSource,
    context: CommandContext,
    item: ReturnType<typeof workItemId>,
    workflow: ReturnType<typeof workflowInstanceId>,
  ): Promise<void> {
    const stream = controlPlaneStream();
    const draft = createControlPlaneEventData({
      eventId: `${workflow}:${ControlEventType.TriggerInvocationStarted}`,
      eventType: ControlEventType.TriggerInvocationStarted,
      occurredAt: this.dependencies.now(),
      correlationId: context.correlationId,
      causationId: source.kind === TriggerSourceKind.Event ? source.eventId : context.commandId,
      actor: context.actor,
      source: { kind: EventSourceKind.Internal, id: config.id },
      payload: {
        triggerId: config.id,
        source,
        workItemId: item,
        workflowInstanceId: workflow,
        workflowName: config.workflow,
      },
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const events = await this.dependencies.journal.readStream(stream);
      if (
        events.some((envelope) => {
          const event = selectControlEvent(envelope);
          return (
            event?.event.eventType === ControlEventType.TriggerInvocationStarted &&
            event.event.payload.workflowInstanceId === workflow
          );
        })
      )
        return;
      try {
        await this.dependencies.journal.appendToStream(stream, events.length, [draft]);
        return;
      } catch (error) {
        // Other triggers and runner controls share this stream. Re-read on contention.
        if (!(error instanceof WrongExpectedSequenceError) || attempt === 7) throw error;
      }
    }
  }
}

export function createTriggerReactor(
  service: TriggerService,
  config: TriggerConfig,
  decode: (event: EventEnvelope) => void,
) {
  return defineEventProcessor({
    consumer: `reactor:control-plane.trigger:${config.id}`,
    name: 'workflow-triggers',
    owner: ControlStreamKind.Global,
    category: EventProcessorCategory.Reactor,
    replayPolicy: EventProcessorReplayPolicy.Idempotent,
    select(event) {
      if (!config.on.events?.includes(event.event.eventType)) return null;
      decode(event);
      return event;
    },
    async handle(event) {
      await service.start(
        config,
        {
          kind: TriggerSourceKind.Event,
          eventId: event.event.eventId,
          eventType: event.event.eventType,
        },
        {
          commandId: `trigger:${config.id}:${event.event.eventId}`,
          correlationId: correlationId(`trigger:${config.id}:${event.event.eventId}`),
          occurredAt: event.event.occurredAt,
          actor: { kind: EventActorKind.System, id: config.id },
        },
      );
    },
  });
}
