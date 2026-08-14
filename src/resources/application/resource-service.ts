import {
  createEventDraft,
  EventSourceKind,
  type CommandContext,
  type EventJournal,
} from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { DiscoverResource } from '../contracts/commands.js';
import {
  ResourceEventType,
  type ResourceEventDraft,
  type ResourceEventPayloads,
} from '../contracts/events.js';
import type { ResourceId } from '../contracts/identifiers.js';
import { resourceStream } from '../contracts/streams.js';
import type {
  ExternalResourceKey,
  ResourceCorrelationView,
  ResourceView,
} from '../contracts/views.js';
import {
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
  type ResourceCorrelationProvenance as CorrelationProvenance,
} from '../contracts/vocabulary.js';
import type { ResourceLookup } from './resource-lookup.js';
import { ResourceRepository } from './resource-repository.js';

export interface ResourceService {
  discover(command: DiscoverResource, context: CommandContext): Promise<ResourceView>;
  get(resourceId: ResourceId): Promise<ResourceView | null>;
  findByExternalKey(externalKey: ExternalResourceKey): Promise<ResourceView | null>;
  correlations(resourceId: ResourceId): Promise<readonly ResourceCorrelationView[]>;
  correlationsForWork(workItemId: WorkItemId): Promise<readonly ResourceCorrelationView[]>;
  correlate(
    resourceId: ResourceId,
    workItemId: WorkItemId,
    role: typeof ResourceCorrelationRole.Primary | typeof ResourceCorrelationRole.Secondary,
    context: CommandContext,
    provenance?: CorrelationProvenance,
  ): Promise<ResourceCorrelationView>;
  retract(resourceId: ResourceId, workItemId: WorkItemId, context: CommandContext): Promise<void>;
  consumeIssueCompletion(
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
    async consumeIssueCompletion(resourceId, intentEventId, context) {
      await appendResourceEvent(
        repository,
        resourceId,
        resourceDraft(resourceId, context, ResourceEventType.IssueCompletionObservationConsumed, {
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
  draft: ResourceEventDraft,
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
  return createEventDraft({
    eventId: `${context.commandId}:${eventType}`,
    eventType,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: 'resource-service' },
    stream: resourceStream(resourceId),
    payload,
  });
}
