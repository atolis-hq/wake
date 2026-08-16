import { createHash } from 'node:crypto';
import {
  createEventDraft,
  EventActorKind,
  EventSourceKind,
  type EventJournal,
  type ProjectionDefinition,
  type ProjectionStore,
} from '../../kernel/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import { selectOrchestrationEvent } from '../contracts/event-decoder.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { type WorkflowName } from '../contracts/identifiers.js';
import { OrchestrationStreamKind, workflowDefinitionsStream } from '../contracts/streams.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { claimWithCasRetry } from './durable-append.js';

export const workflowDefinitionFingerprint = (definition: CompiledWorkflow): string =>
  createHash('sha256').update(JSON.stringify(definition)).digest('hex');

export const workflowDefinitionKey = (name: WorkflowName, fingerprint: string): string =>
  `${name}:${fingerprint}`;

export const workflowDefinitionsProjection: ProjectionDefinition<CompiledWorkflow> = {
  name: OrchestrationStreamKind.WorkflowDefinitions,
  select(event) {
    const owned = selectOrchestrationEvent(event);
    return owned?.eventType === OrchestrationEventType.WorkflowDefinitionRegistered
      ? { key: workflowDefinitionKey(owned.payload.workflowName, owned.payload.fingerprint) }
      : null;
  },
  initial: () => undefined as never,
  project(_previous, event) {
    const owned = selectOrchestrationEvent(event);
    if (owned?.eventType !== OrchestrationEventType.WorkflowDefinitionRegistered)
      throw new Error('Expected workflow definition registration');
    return owned.payload.compiledDefinition;
  },
};

export class WorkflowDefinitionUnavailableError extends Error {
  constructor() {
    super('workflow-definition-unavailable');
    this.name = 'WorkflowDefinitionUnavailableError';
  }
}

export class WorkflowDefinitionRegistry {
  // WorkflowDefinitionRegistered events are never retracted, so once a
  // (name, fingerprint) pair is observed registered it stays registered for
  // the life of this process — caching it skips the shared-stream scan that
  // register() would otherwise repeat on every workflow/child start.
  private readonly knownRegistered = new Set<string>();

  constructor(
    private readonly journal: EventJournal,
    private readonly projections: ProjectionStore | undefined,
    private readonly current: Readonly<Record<string, CompiledWorkflow>>,
  ) {}

  currentDefinition(name: WorkflowName): {
    readonly definition: CompiledWorkflow;
    readonly fingerprint: string;
  } {
    const definition = this.current[name];
    if (definition === undefined) throw new Error(`Unknown workflow: ${name}`);
    return { definition, fingerprint: workflowDefinitionFingerprint(definition) };
  }

  async register(
    name: WorkflowName,
    fingerprint: string,
    definition: CompiledWorkflow,
    context: {
      readonly occurredAt: string;
      readonly correlationId: string;
      readonly commandId: string;
    },
  ): Promise<void> {
    if (await this.isRegistered(name, fingerprint)) return;
    const stream = workflowDefinitionsStream();
    const draft = createEventDraft({
      eventId: `workflow-definition:${name}:${fingerprint}`,
      eventType: OrchestrationEventType.WorkflowDefinitionRegistered,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
      actor: { kind: EventActorKind.System, id: 'orchestration' },
      source: { kind: EventSourceKind.Internal, id: 'orchestration' },
      stream,
      payload: { workflowName: name, fingerprint, compiledDefinition: definition },
    });
    // The deterministic event id makes retries idempotent; CAS protects the
    // one shared registration stream when different definitions race to start.
    await claimWithCasRetry({
      read: () => this.journal.readStream(stream),
      decode: (events) => events,
      alreadyClaimed: (events) =>
        events.some((event) => {
          const owned = selectOrchestrationEvent(event);
          return (
            owned?.eventType === OrchestrationEventType.WorkflowDefinitionRegistered &&
            owned.payload.workflowName === name &&
            owned.payload.fingerprint === fingerprint
          );
        }),
      append: async (sequence) => {
        await this.journal.append(stream, sequence, [draft]);
      },
    });
    this.knownRegistered.add(workflowDefinitionKey(name, fingerprint));
  }

  private async isRegistered(name: WorkflowName, fingerprint: string): Promise<boolean> {
    const key = workflowDefinitionKey(name, fingerprint);
    if (this.knownRegistered.has(key)) return true;
    const found = (await this.journal.readStream(workflowDefinitionsStream())).some((event) => {
      const owned = selectOrchestrationEvent(event);
      return (
        owned?.eventType === OrchestrationEventType.WorkflowDefinitionRegistered &&
        owned.payload.workflowName === name &&
        owned.payload.fingerprint === fingerprint
      );
    });
    if (found) this.knownRegistered.add(key);
    return found;
  }

  async resolve(
    view: Pick<WorkflowInstanceView, 'workflowName' | 'workflowDefinitionFingerprint'>,
  ): Promise<CompiledWorkflow> {
    if (view.workflowDefinitionFingerprint === undefined)
      return this.currentDefinition(view.workflowName).definition;
    const current = this.current[view.workflowName];
    if (
      current !== undefined &&
      workflowDefinitionFingerprint(current) === view.workflowDefinitionFingerprint
    )
      return current;
    const stored = await this.projections?.read<CompiledWorkflow>(
      workflowDefinitionsProjection.name,
      workflowDefinitionKey(view.workflowName, view.workflowDefinitionFingerprint),
    );
    if (stored === null || stored === undefined) throw new WorkflowDefinitionUnavailableError();
    return stored.value;
  }
}
