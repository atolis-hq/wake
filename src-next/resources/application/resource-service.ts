import {
  createEventDraft,
  entityRef,
  type CommandContext,
  type EventJournal,
} from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { DiscoverResource } from '../contracts/commands.js';
import { resourceId, type ResourceId } from '../contracts/identifiers.js';
import type {
  ExternalResourceKey,
  ResourceCorrelationView,
  ResourceView,
} from '../contracts/views.js';
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
    role: 'primary' | 'secondary',
    context: CommandContext,
  ): Promise<ResourceCorrelationView>;
  retract(resourceId: ResourceId, workItemId: WorkItemId, context: CommandContext): Promise<void>;
}

export function createResourceService(journal: EventJournal): ResourceService {
  const repository = new ResourceRepository(journal);

  async function append(
    resourceId: ResourceId,
    context: CommandContext,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    const loaded = await repository.load(resourceId);
    await repository.append(resourceId, loaded.sequence, [
      createEventDraft({
        eventId: `${context.commandId}:${eventType}`,
        eventType,
        occurredAt: context.occurredAt,
        correlationId: context.correlationId,
        causationId: context.commandId,
        actor: context.actor,
        source: { kind: 'internal', id: 'resource-service' },
        stream: entityRef('resource', resourceId),
        payload,
      }),
    ]);
  }

  return {
    async discover(command, context) {
      await append(command.resourceId, context, 'resources.resource-discovered', {
        kind: command.kind,
        externalKey: command.externalKey,
        capabilities: command.capabilities,
        ...(command.revision === undefined ? {} : { revision: command.revision }),
      });
      const resource = (await repository.load(command.resourceId)).resource;
      if (resource === null) throw new Error(`Resource ${command.resourceId} was not discovered`);
      return resource.view;
    },
    async get(resourceId) {
      return (await repository.load(resourceId)).resource?.view ?? null;
    },
    async findByExternalKey(externalKey) {
      return (await repository.findByExternalKey(externalKey))?.view ?? null;
    },
    async correlations(resourceId) {
      return (await repository.load(resourceId)).resource?.correlations ?? [];
    },
    async correlationsForWork(workItemId) {
      const events = await journal.readAll(0);
      const ids = new Set(
        events
          .filter((event) => event.stream.kind === 'resource')
          .map((event) => resourceId(event.stream.id)),
      );
      const correlations = await Promise.all(
        [...ids].map(async (id) => (await repository.load(id)).resource?.correlations ?? []),
      );
      return correlations.flat().filter((correlation) => correlation.workItemId === workItemId);
    },
    async correlate(resourceId, workItemId, role, context) {
      const loaded = await repository.load(resourceId);
      if (loaded.resource === null) throw new Error(`Resource ${resourceId} does not exist`);
      const primary = loaded.resource.correlations.find(
        (correlation) => correlation.role === 'primary',
      );
      if (role === 'primary' && primary !== undefined && primary.workItemId !== workItemId) {
        await append(resourceId, context, 'resources.work-correlation-conflicted', {
          workItemId,
          existingWorkItemId: primary.workItemId,
        });
        throw new Error(`Resource ${resourceId} already has a primary WorkItem correlation`);
      }
      await append(resourceId, context, 'resources.work-correlation-established', {
        workItemId,
        role,
      });
      const correlation = (await repository.load(resourceId)).resource?.correlations.find(
        (candidate) => candidate.workItemId === workItemId && candidate.role === role,
      );
      if (correlation === undefined) throw new Error('Resource correlation was not established');
      return correlation;
    },
    async retract(resourceId, workItemId, context) {
      await append(resourceId, context, 'resources.work-correlation-retracted', { workItemId });
    },
  };
}
