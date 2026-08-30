import { EventSourceKind, type CommandContext, type EventJournal } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { DiscoverResource } from '../contracts/commands.js';
import { createResourceEventData } from '../contracts/event-factory.js';
import {
  ResourceEventType,
  type ResourceEventData,
  type ResourceEventPayloads,
} from '../contracts/events.js';
import type { ResourceId } from '../contracts/identifiers.js';
import type {
  ExternalResourceKey,
  ResourceCorrelationView,
  ResourceView,
} from '../contracts/views.js';
import {
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
  type ResourceCorrelationProvenance as CorrelationProvenance,
  type ResourceExternalOutcome,
} from '../contracts/vocabulary.js';
import {
  noteMissingPrimaryCorrelation,
  observeExternalOutcome,
  pendingExternalOutcomes,
  retryPendingWorkCorrelations,
} from './resource-correlation-retry.js';
import type { ResourceLookup } from './resource-lookup.js';
import { ResourceRepository } from './resource-repository.js';

export interface ResourceService {
  discover(command: DiscoverResource, context: CommandContext): Promise<ResourceView>;
  get(resourceId: ResourceId): Promise<ResourceView | null>;
  findByExternalKey(externalKey: ExternalResourceKey): Promise<ResourceView | null>;
  correlations(resourceId: ResourceId): Promise<readonly ResourceCorrelationView[]>;
  primaryCorrelation(resourceId: ResourceId): Promise<ResourceCorrelationView | null>;
  correlationsForWork(workItemId: WorkItemId): Promise<readonly ResourceCorrelationView[]>;
  correlate(
    resourceId: ResourceId,
    workItemId: WorkItemId,
    role: typeof ResourceCorrelationRole.Primary | typeof ResourceCorrelationRole.Secondary,
    context: CommandContext,
    provenance?: CorrelationProvenance,
  ): Promise<ResourceCorrelationView>;
  retract(resourceId: ResourceId, workItemId: WorkItemId, context: CommandContext): Promise<void>;
  /** Records a failed active-primary lookup; retries are advanced independently each tick. */
  noteMissingPrimaryCorrelation(
    resourceId: ResourceId,
    reason: string,
    context: CommandContext,
  ): Promise<void>;
  retryPendingWorkCorrelations(): Promise<number>;
  observeExternalOutcome(
    resourceId: ResourceId,
    observation: {
      readonly sourceObservationId: string;
      readonly outcome?: ResourceExternalOutcome;
      readonly revision: string;
    },
    context: CommandContext,
  ): Promise<void>;
  pendingExternalOutcomes(): Promise<
    readonly {
      readonly resourceId: ResourceId;
      readonly outcome: ResourceExternalOutcome;
      readonly sourceObservationId: string;
    }[]
  >;
  consumeExternalOutcome(
    resourceId: ResourceId,
    sourceObservationId: string,
    context: CommandContext,
  ): Promise<void>;
  consumeIssueCompletion(
    resourceId: ResourceId,
    intentEventId: string,
    context: CommandContext,
  ): Promise<void>;
  supersedeIssueCompletion(
    resourceId: ResourceId,
    intentEventId: string,
    context: CommandContext,
  ): Promise<void>;
}

export function createResourceService(
  journal: EventJournal,
  lookup: ResourceLookup,
): ResourceService {
  const repository = new ResourceRepository(journal);
  return {
    discover: (command, context) => discoverResource(repository, command, context),
    async get(resourceId) {
      return (await repository.load(resourceId)).resource?.view ?? null;
    },
    async findByExternalKey(externalKey) {
      const id = await lookup.resourceIdForExternalKey(externalKey);
      return id === null ? null : ((await repository.load(id)).resource?.view ?? null);
    },
    async correlations(resourceId) {
      return (await repository.load(resourceId)).resource?.correlations ?? [];
    },
    primaryCorrelation: (resourceId) => lookup.primaryCorrelation(resourceId),
    correlationsForWork: (workItemId) => lookup.correlationsForWork(workItemId),
    correlate: (resourceId, workItemId, role, context, provenance) =>
      correlateResource(repository, resourceId, workItemId, role, context, provenance),
    async retract(resourceId, workItemId, context) {
      await appendResourceEvent(
        repository,
        resourceId,
        resourceDraft(resourceId, context, ResourceEventType.WorkCorrelationRetracted, {
          workItemId,
        }),
      );
    },
    noteMissingPrimaryCorrelation: (resourceId, reason, context) =>
      noteMissingPrimaryCorrelation(repository, resourceId, reason, context),
    retryPendingWorkCorrelations: () => retryPendingWorkCorrelations(repository),
    observeExternalOutcome: (resourceId, observation, context) =>
      observeExternalOutcome(repository, resourceId, observation, context),
    pendingExternalOutcomes: () => pendingExternalOutcomes(repository),
    consumeExternalOutcome: (resourceId, sourceObservationId, context) =>
      appendResourceEvent(
        repository,
        resourceId,
        resourceDraft(resourceId, context, ResourceEventType.ExternalOutcomeConsumed, {
          sourceObservationId,
        }),
      ),
    async consumeIssueCompletion(resourceId, intentEventId, context) {
      await appendResourceEvent(
        repository,
        resourceId,
        resourceDraft(resourceId, context, ResourceEventType.IssueCompletionObservationConsumed, {
          intentEventId,
        }),
      );
    },
    async supersedeIssueCompletion(resourceId, intentEventId, context) {
      await appendResourceEvent(
        repository,
        resourceId,
        resourceDraft(resourceId, context, ResourceEventType.IssueCompletionObservationSuperseded, {
          intentEventId,
        }),
      );
    },
  };
}

async function discoverResource(
  repository: ResourceRepository,
  command: DiscoverResource,
  context: CommandContext,
): Promise<ResourceView> {
  const existing = (await repository.load(command.resourceId)).resource;
  if (existing !== null) {
    if (command.revision !== undefined && existing.view.revision !== command.revision)
      await appendResourceEvent(
        repository,
        command.resourceId,
        resourceDraft(command.resourceId, context, ResourceEventType.ResourceRevisionObserved, {
          revision: command.revision,
        }),
      );
    return (await repository.load(command.resourceId)).resource!.view;
  }
  await appendResourceEvent(
    repository,
    command.resourceId,
    resourceDraft(command.resourceId, context, ResourceEventType.ResourceDiscovered, {
      kind: command.kind,
      externalKey: command.externalKey,
      capabilities: command.capabilities,
      ...(command.revision === undefined ? {} : { revision: command.revision }),
      ...(command.title === undefined ? {} : { title: command.title }),
    }),
  );
  const resource = (await repository.load(command.resourceId)).resource;
  if (resource === null) throw new Error(`Resource ${command.resourceId} was not discovered`);
  return resource.view;
}

// Provenance is an explicit fifth command argument; the repository dependency is the sixth implementation concern.
async function correlateResource(
  repository: ResourceRepository,
  resourceId: ResourceId,
  workItemId: WorkItemId,
  role: typeof ResourceCorrelationRole.Primary | typeof ResourceCorrelationRole.Secondary,
  context: CommandContext,
  provenance: CorrelationProvenance = ResourceCorrelationProvenance.ProviderObserved,
): Promise<ResourceCorrelationView> {
  const loaded = await repository.load(resourceId);
  if (loaded.resource === null) throw new Error(`Resource ${resourceId} does not exist`);
  const primary = loaded.resource.correlations.find(
    (correlation) => correlation.role === ResourceCorrelationRole.Primary,
  );
  if (
    role === ResourceCorrelationRole.Primary &&
    primary !== undefined &&
    primary.workItemId !== workItemId
  ) {
    await appendResourceEvent(
      repository,
      resourceId,
      resourceDraft(resourceId, context, ResourceEventType.WorkCorrelationConflicted, {
        workItemId,
        existingWorkItemId: primary.workItemId,
      }),
    );
    throw new Error(`Resource ${resourceId} already has a primary WorkItem correlation`);
  }
  await appendResourceEvent(
    repository,
    resourceId,
    resourceDraft(resourceId, context, ResourceEventType.WorkCorrelationEstablished, {
      workItemId,
      role,
      provenance,
    }),
  );
  const correlation = (await repository.load(resourceId)).resource?.correlations.find(
    (candidate) => candidate.workItemId === workItemId && candidate.role === role,
  );
  if (correlation === undefined) throw new Error('Resource correlation was not established');
  return correlation;
}

async function appendResourceEvent(
  repository: ResourceRepository,
  resourceId: ResourceId,
  draft: ResourceEventData,
): Promise<void> {
  const loaded = await repository.load(resourceId);
  await repository.append(resourceId, loaded.sequence, [draft]);
}

function resourceDraft<Type extends keyof ResourceEventPayloads>(
  resourceId: ResourceId,
  context: CommandContext,
  eventType: Type,
  payload: ResourceEventPayloads[Type],
) {
  return createResourceEventData({
    eventId: `${context.commandId}:${eventType}`,
    eventType,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: 'resource-service' },
    payload,
  });
}
