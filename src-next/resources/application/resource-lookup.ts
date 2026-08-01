import type { EventJournal, ProjectionDefinition, ProjectionStore } from '../../kernel/index.js';
import type { ResourceId } from '../contracts/identifiers.js';
import type { ExternalResourceKey, ResourceCorrelationView } from '../contracts/views.js';
import type { WorkItemId } from '../../work/index.js';
import {
  externalKeyProjectionKey,
  resourcesByExternalKeyProjection,
  workCorrelationsProjection,
} from './lookup-projections.js';

export interface ResourceLookup {
  resourceIdForExternalKey(externalKey: ExternalResourceKey): Promise<ResourceId | null>;
  correlationsForWork(workItemId: WorkItemId): Promise<readonly ResourceCorrelationView[]>;
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
  };
}
