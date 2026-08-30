import type { EventJournal, ProjectionDefinition, ProjectionStore } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import { ResourceEventType, selectResourceEvent } from '../contracts/events.js';
import type { ResourceId } from '../contracts/identifiers.js';
import { resourceStream } from '../contracts/streams.js';
import type { ExternalResourceKey, ResourceCorrelationView } from '../contracts/views.js';
import { ResourceCorrelationRole } from '../contracts/vocabulary.js';
import {
  externalKeyProjectionKey,
  resourcesByExternalKeyProjection,
  workCorrelationsProjection,
} from './lookup-projections.js';

export interface ResourceLookup {
  resourceIdForExternalKey(externalKey: ExternalResourceKey): Promise<ResourceId | null>;
  correlationsForWork(workItemId: WorkItemId): Promise<readonly ResourceCorrelationView[]>;
  /**
   * Returns the active primary correlation, or the most recently retracted
   * primary correlation when the Resource has no active primary.
   */
  primaryCorrelation(resourceId: ResourceId): Promise<ResourceCorrelationView | null>;
}

export function createResourceLookup(dependencies: {
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
}): ResourceLookup {
  const seeded = async <View>(
    definition: ProjectionDefinition<View>,
    key: string,
  ): Promise<View> => {
    const stored = await dependencies.projections.read<View>(definition.name, key);
    let value = stored?.value ?? definition.initial(key);
    for (const event of await dependencies.journal.readAll(stored?.lastGlobalPosition ?? 0)) {
      if (definition.select(event)?.key === key) value = definition.project(value, event);
    }
    return value;
  };

  return {
    resourceIdForExternalKey: (externalKey) =>
      seeded(resourcesByExternalKeyProjection, externalKeyProjectionKey(externalKey)),
    correlationsForWork: (workItemId) => seeded(workCorrelationsProjection, workItemId),
    async primaryCorrelation(resourceId) {
      const active = new Map<WorkItemId, ResourceCorrelationView>();
      const retracted: ResourceCorrelationView[] = [];
      for (const event of await dependencies.journal.readStream(resourceStream(resourceId))) {
        const owned = selectResourceEvent(event);
        if (owned?.event.eventType === ResourceEventType.WorkCorrelationEstablished) {
          active.set(owned.event.payload.workItemId, {
            resourceId,
            workItemId: owned.event.payload.workItemId,
            role: owned.event.payload.role,
            provenance: owned.event.payload.provenance,
            establishedByEventId: owned.event.eventId,
          });
        }
        if (owned?.event.eventType === ResourceEventType.WorkCorrelationRetracted) {
          const correlation = active.get(owned.event.payload.workItemId);
          if (correlation !== undefined) {
            active.delete(owned.event.payload.workItemId);
            if (correlation.role === ResourceCorrelationRole.Primary) retracted.push(correlation);
          }
        }
      }
      return (
        [...active.values()].find((value) => value.role === ResourceCorrelationRole.Primary) ??
        retracted.at(-1) ??
        null
      );
    },
  };
}
