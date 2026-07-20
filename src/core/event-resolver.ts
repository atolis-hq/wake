import type { ResourceIndex, UnkeyedEventEnvelope } from './contracts.js';
import type { createProjectionUpdater } from './projection-updater.js';
import type { Clock } from '../lib/clock.js';
import { createWorkId } from '../lib/work-id.js';
import {
  CORRELATION_REGISTERED_EVENT,
  UNRESOLVED_WORK_ITEM_KEY,
  WORK_ITEM_CREATED_EVENT,
} from '../domain/schema.js';
import type { EventEnvelope, WakeConfig } from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';

type StateStore = ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
type ProjectionUpdater = ReturnType<typeof createProjectionUpdater>;

// A resolved inbound event plus whether it is already on record. `persisted`
// events are folded but not re-appended (appendEventEnvelope would only re-read
// and return the identical envelope).
type ResolvedInboundEvent = { envelope: EventEnvelope; persisted: boolean };

// How an unkeyed source event becomes a work item — the correlation-resolution
// subsystem described in docs/adrs/0001-correlating-external-resources-to-work-items.md.
export function createEventResolver(deps: {
  clock: Clock;
  config: WakeConfig;
  stateStore: StateStore;
  resourceIndex: ResourceIndex;
  projectionUpdater: ProjectionUpdater;
  qualifiesForMint: (unkeyed: UnkeyedEventEnvelope, config: WakeConfig) => boolean;
}) {
  // Events are stamped by reading the clock at the moment of stamping, never
  // from a frozen tick-start snapshot. `tickStartedAt` is the tick's *decision*
  // clock (policy/staleness), and reusing it to date events inverts them
  // against the work source's own poll-time ingestedAt — pollEvents() runs
  // after tickStartedAt is captured, so in production every polled upsert is
  // LATER than the tick's start. An event dated before the upsert that creates
  // the projection it folds into sorts ahead of it in rebuildFromEvents' global
  // replay, folds against `current === null`, and is silently dropped. Reading
  // per event also stays correct once ticks work items in parallel, where a
  // shared per-tick snapshot would tie every concurrent event on ingestedAt and
  // leave append order as the only discriminator.
  function eventStampNow(): string {
    return deps.clock.now().toISOString();
  }

  // Returns whichever of the two timestamps is unambiguously later, defaulting
  // to `left`. `right` wins only if it is later by BOTH the actual instant and
  // the lexicographic order rebuildFromEvents sorts on — the envelope schema is
  // `z.string().datetime({ offset: true })`, so a timestamp may legally carry a
  // non-UTC offset or differing sub-second precision, and lexicographic order
  // alone is not a reliable proxy for chronology across those formats. Falling
  // back to `left` (the source event's own exact string) is always safe: it
  // ties with that event under localeCompare, and the stable sort then preserves
  // append order, which puts the mint events after it — exactly what we need.
  function laterTimestamp(left: string, right: string): string {
    const isLater = Date.parse(right) > Date.parse(left) && right.localeCompare(left) > 0;
    return isLater ? right : left;
  }

  // The two internal events a mint (or a heal) appends after the source event
  // that founded a work item: wake.workitem.created, then the
  // wake.correlation.registered that claims the originating resource as this
  // work item's primary representation. Their ids are derived from the work id,
  // so re-emitting them is idempotent — appendEventEnvelope dedups on the id.
  //
  // Ordering and timestamps matter, and not only for readability. Both fold
  // against the projection the source event creates, and applyEvent drops
  // anything that folds while `current === null`. So they must never sort
  // *before* that source event in rebuildFromEvents' globally-ordered replay —
  // if they did, replay would silently discard the registration, leaving
  // correlatedResources[] empty and the index unpopulated, while the events
  // still on record stop any later tick from re-registering. Permanent,
  // self-concealing loss (Task 5, round 3). Reading the clock here is already
  // after pollEvents(), but that alone is not a guarantee: the source event's
  // ingestedAt comes from the *source's* clock, which for a real source is
  // another machine's and can legitimately run ahead of ours. Anchoring on the
  // source event's own timestamp makes the ordering hold by construction rather
  // than by clock agreement; appending the source event first means a tie
  // resolves in its favour (the sort is stable, so equal timestamps keep append
  // order).
  function buildOriginCorrelationEvents(
    workItemKey: string,
    unkeyed: UnkeyedEventEnvelope,
    resourceUri: string,
  ): EventEnvelope[] {
    const mintedAt = laterTimestamp(unkeyed.ingestedAt, eventStampNow());
    const sourceRefs = {
      ...unkeyed.sourceRefs,
      resourceUri,
    };

    const createdEvent = createEventEnvelope({
      eventId: `${workItemKey}-created`,
      workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: WORK_ITEM_CREATED_EVENT,
      sourceRefs,
      occurredAt: mintedAt,
      ingestedAt: mintedAt,
      trigger: 'context-only',
      // The envelope's workItemKey already carries the identity.
      payload: {},
    });

    const registeredEvent = createEventEnvelope({
      eventId: `${workItemKey}-origin-correlation`,
      workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: CORRELATION_REGISTERED_EVENT,
      sourceRefs,
      occurredAt: mintedAt,
      ingestedAt: mintedAt,
      trigger: 'context-only',
      payload: {
        resourceUri,
        role: 'representation',
        relation: 'primary',
        provenance: 'wake-created',
      },
    });

    return [createdEvent, registeredEvent];
  }

  // The central resolver (spec D1): sources name the *resource* an event came
  // from and never the work item, so between pollEvents() and the append every
  // inbound event's sourceRefs.resourceUri is resolved through the reverse
  // index to the canonical workItemKey, minting a work item on a miss. This is
  // the one mechanism — there is no founding-surface special case, and no
  // resolution is ever cached in process memory between ticks (CLAUDE.md: the
  // tick is a pure function of durable state; the index on disk *is* that
  // state).
  //
  // Each resolved event carries whether it is already `persisted`, so the
  // caller can skip re-appending it (appendEventEnvelope would only re-read it
  // and hand back the same envelope). Minting *is* registration, so a freshly
  // minted work item's correlatedResources[] is complete from its first event.
  async function resolveInboundEvent(
    unkeyed: UnkeyedEventEnvelope,
  ): Promise<ResolvedInboundEvent[]> {
    const { resourceUri } = unkeyed.sourceRefs;
    if (resourceUri === undefined) {
      // A programming error in the adapter, not a runtime condition to absorb.
      // Guessing an identity here would silently fork a duplicate work item
      // for work already in flight — exactly the corruption the reverse index
      // exists to prevent — so fail loudly instead.
      throw new Error(
        `cannot resolve inbound event ${unkeyed.eventId} from ${unkeyed.sourceSystem}: ` +
          'sourceRefs.resourceUri is required for every unkeyed source event',
      );
    }

    // An event we have already persisted was already resolved, on some earlier
    // tick, and its stamped key is the durable answer. Re-resolving it through
    // the index would be wrong as well as wasteful: if that work item has since
    // retracted this resource, the index no longer holds it, the lookup misses,
    // and a miss means mint — so a re-polled event (sources legitimately
    // re-emit the same eventId, e.g. an unchanged issue) would fork a duplicate
    // work item. Reusing the persisted key keeps resolution idempotent per
    // event id, which is what the append-only log already promises.
    const persisted = await deps.stateStore.readEventEnvelope(unkeyed.eventId);
    if (persisted !== null) {
      // Heal a partially minted work item. The index entry for a resource is
      // written only when its origin wake.correlation.registered event is
      // *folded*, several appends after the founding source event. A crash in
      // that window leaves the source event durable — so this branch suppresses
      // re-minting — while the index has no entry, and a later event on the
      // same resource would miss the index and fork a duplicate work item
      // (crash/restart safety, CLAUDE.md). If the index does not credit this
      // event's work item *and* its origin correlation never landed, re-emit
      // the mint tail (idempotent by id). The guard is the missing origin
      // event, not merely an empty index: a deliberately *retracted* resource
      // also resolves to undefined but keeps its origin-correlation event on
      // record, and must not be silently re-registered.
      const owner = await deps.resourceIndex.resolve(resourceUri);
      if (
        persisted.workItemKey !== UNRESOLVED_WORK_ITEM_KEY &&
        owner === undefined &&
        (await deps.stateStore.readEventEnvelope(`${persisted.workItemKey}-origin-correlation`)) ===
          null
      ) {
        return [
          { envelope: persisted, persisted: true },
          ...buildOriginCorrelationEvents(persisted.workItemKey, unkeyed, resourceUri).map(
            (envelope) => ({ envelope, persisted: false }),
          ),
        ];
      }
      return [{ envelope: persisted, persisted: true }];
    }

    const existingWorkItemKey = await deps.resourceIndex.resolve(resourceUri);
    if (existingWorkItemKey !== undefined) {
      return [
        {
          envelope: createEventEnvelope({ ...unkeyed, workItemKey: existingWorkItemKey }),
          persisted: false,
        },
      ];
    }

    // resourceUri itself misses the index (e.g. a review-thread comment's
    // resourceUri is unique per thread, never registered on its own), but the
    // adapter may have named a parent resource this one belongs to. Resolve
    // through that instead of minting — and register this exact resourceUri
    // as a secondary correlation so it's on record on the work item, even
    // though (being secondary) it still won't shortcut future lookups via the
    // index itself (ADR 0001 §5: the index is primary-only).
    if (unkeyed.sourceRefs.parentResourceUri !== undefined) {
      const parentWorkItemKey = await deps.resourceIndex.resolve(
        unkeyed.sourceRefs.parentResourceUri,
      );
      if (parentWorkItemKey !== undefined) {
        const mintedAt = laterTimestamp(unkeyed.ingestedAt, eventStampNow());
        return [
          {
            envelope: createEventEnvelope({ ...unkeyed, workItemKey: parentWorkItemKey }),
            persisted: false,
          },
          {
            envelope: createEventEnvelope({
              eventId: `${parentWorkItemKey}-correlation-${resourceUri.replace(/[^a-z0-9]+/gi, '-')}`,
              workItemKey: parentWorkItemKey,
              streamScope: 'work-item',
              direction: 'internal',
              sourceSystem: 'wake',
              sourceEventType: CORRELATION_REGISTERED_EVENT,
              sourceRefs: unkeyed.sourceRefs,
              occurredAt: mintedAt,
              ingestedAt: mintedAt,
              trigger: 'context-only',
              payload: {
                resourceUri,
                role: 'review',
                relation: 'secondary',
                provenance: 'detected',
              },
            }),
            persisted: false,
          },
        ];
      }
    }

    if (!deps.qualifiesForMint(unkeyed, deps.config)) {
      return [
        {
          envelope: createEventEnvelope({ ...unkeyed, workItemKey: UNRESOLVED_WORK_ITEM_KEY }),
          persisted: false,
        },
      ];
    }

    const workItemKey = createWorkId();
    const keyed = createEventEnvelope({ ...unkeyed, workItemKey });

    return [
      { envelope: keyed, persisted: false },
      ...buildOriginCorrelationEvents(workItemKey, unkeyed, resourceUri).map((envelope) => ({
        envelope,
        persisted: false,
      })),
    ];
  }

  async function ingestInboundEvents(
    unkeyedEvents: UnkeyedEventEnvelope[],
  ): Promise<EventEnvelope[]> {
    const ingested: EventEnvelope[] = [];

    for (const unkeyed of unkeyedEvents) {
      const resolved = await resolveInboundEvent(unkeyed);
      // Fold what was actually persisted, never the in-memory copy:
      // appendEventEnvelope is id-deduplicated and returns the *existing*
      // envelope when one is already on record. Folding our own copy instead
      // would let state/ diverge from events/ — and replay is defined by
      // events/, so the divergence would only surface after a rebuild. An event
      // already flagged `persisted` needs no second append: appendEventEnvelope
      // would only re-read it off disk and hand back the same envelope, and
      // every unchanged issue is re-polled every tick, so that read is the
      // dominant redundant cost this branch avoids.
      const events: EventEnvelope[] = [];
      for (const { envelope, persisted } of resolved) {
        events.push(persisted ? envelope : await deps.stateStore.appendEventEnvelope(envelope));
      }
      // Folded before the next event is resolved, because it is the fold of
      // the registration event that writes the index entry the *next* event on
      // the same resource resolves through. Deferring the fold to the end of
      // the batch would let a second event for the same ticket miss and mint a
      // duplicate work item. Every event in a poll batch shares the source's
      // one ingestedAt, so folding per event preserves exactly the order a
      // single batched fold would have produced.
      await deps.projectionUpdater.rebuildFromEvents(events);
      ingested.push(...events);
    }

    return ingested;
  }

  return { ingestInboundEvents };
}
