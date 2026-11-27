import {
  foldedJournalView,
  type EventEnvelope,
  type EventJournal,
  type JournalView,
} from '@atolis-hq/eventing';
import type { WorkItemId } from '../../work/index.js';
import { ResourceEventType, selectResourceEvent } from '../contracts/events.js';
import type { ResourceId } from '../contracts/identifiers.js';
import { isResourceStream } from '../contracts/streams.js';
import type { ExternalResourceKey, ResourceCorrelationView } from '../contracts/views.js';

/** Resource identity and correlations as of one journal position, answerable without I/O. */
export interface ResourceCorrelationSnapshot {
  externalKey(resourceId: ResourceId): ExternalResourceKey | null;
  correlations(resourceId: ResourceId): readonly ResourceCorrelationView[];
  correlationsForWork(workItemId: WorkItemId): readonly ResourceCorrelationView[];
}

interface ResourceEntry {
  readonly externalKey: ExternalResourceKey;
  readonly active: ReadonlyMap<WorkItemId, ResourceCorrelationView>;
}

interface ResourceIndexState {
  readonly resources: ReadonlyMap<ResourceId, ResourceEntry>;
  readonly byWork: ReadonlyMap<WorkItemId, readonly ResourceCorrelationView[]>;
  readonly invalid: ReadonlySet<ResourceId>;
}

/**
 * Per-resource external key and active correlations, extended with each journal
 * move. Holds no events or full resource views, so memory is bounded by the
 * number of resources and live correlations. A malformed stream poisons only its
 * own resource, which then reads as unknown.
 */
export class ResourceIndex {
  private readonly state: JournalView<ResourceIndexState>;

  constructor(journal: Pick<EventJournal, 'readAll' | 'latestGlobalPosition'>) {
    this.state = foldedJournalView(journal, {
      initial: { resources: new Map(), byWork: new Map(), invalid: new Set() },
      extend: extendResourceIndex,
    });
  }

  async snapshot(): Promise<ResourceCorrelationSnapshot> {
    const { resources, byWork } = await this.state.get();
    return {
      externalKey: (id) => resources.get(id)?.externalKey ?? null,
      correlations: (id) => [...(resources.get(id)?.active.values() ?? [])],
      correlationsForWork: (id) => byWork.get(id) ?? [],
    };
  }
}

function extendResourceIndex(
  state: ResourceIndexState,
  envelopes: readonly EventEnvelope[],
): ResourceIndexState {
  const resources = new Map(state.resources);
  const byWork = new Map(state.byWork);
  const invalid = new Set(state.invalid);
  for (const envelope of envelopes) {
    let owned;
    try {
      owned = selectResourceEvent(envelope);
    } catch {
      if (isResourceStream(envelope.stream)) invalid.add(envelope.stream.id);
      continue;
    }
    if (owned === null || invalid.has(owned.stream.id)) continue;
    applyEvent(resources, byWork, owned.stream.id, owned);
  }
  for (const id of invalid) {
    if (state.invalid.has(id)) continue;
    resources.delete(id);
    for (const [workItemId, list] of byWork)
      byWork.set(
        workItemId,
        list.filter((value) => value.resourceId !== id),
      );
  }
  return { resources, byWork, invalid };
}

function applyEvent(
  resources: Map<ResourceId, ResourceEntry>,
  byWork: Map<WorkItemId, readonly ResourceCorrelationView[]>,
  id: ResourceId,
  owned: NonNullable<ReturnType<typeof selectResourceEvent>>,
): void {
  const { event } = owned;
  if (event.eventType === ResourceEventType.ResourceDiscovered) {
    // foldResource takes the first discovery as the resource's identity.
    if (!resources.has(id))
      resources.set(id, { externalKey: event.payload.externalKey, active: new Map() });
    return;
  }
  const entry = resources.get(id);
  if (entry === undefined) return;
  if (event.eventType === ResourceEventType.WorkCorrelationEstablished) {
    const correlation: ResourceCorrelationView = {
      resourceId: id,
      workItemId: event.payload.workItemId,
      role: event.payload.role,
      provenance: event.payload.provenance,
      establishedByEventId: event.eventId,
    };
    resources.set(id, {
      ...entry,
      active: new Map(entry.active).set(correlation.workItemId, correlation),
    });
    const existing = byWork.get(correlation.workItemId) ?? [];
    if (!existing.some((value) => value.resourceId === id))
      byWork.set(correlation.workItemId, [...existing, correlation]);
  } else if (event.eventType === ResourceEventType.WorkCorrelationRetracted) {
    const active = new Map(entry.active);
    active.delete(event.payload.workItemId);
    resources.set(id, { ...entry, active });
    const remaining = (byWork.get(event.payload.workItemId) ?? []).filter(
      (value) => value.resourceId !== id,
    );
    if (remaining.length === 0) byWork.delete(event.payload.workItemId);
    else byWork.set(event.payload.workItemId, remaining);
  }
}
