# Resource lookup — Component Specification

## Type, purpose, and scope

Projection. Resource lookup answers the two questions the Resource
aggregate's own per-identity stream cannot answer by itself: which
`ResourceId`, if any, was first discovered under a given external key, and
which Resources are currently correlated to a given `WorkItemId`. It is a
pure, rebuildable fold of `resources.*` facts across all Resource streams,
never a source of truth.

## Ubiquitous language

- **External-key index** — the fold from an external key to the `ResourceId`
  first discovered under it.
- **Work-correlation index** — the fold from a `WorkItemId` to the Resources
  currently correlated to it.

## Responsibilities and boundaries

Resource lookup owns four read models: a per-`ResourceId` summary projection,
a per-`ResourceId` correlation-list projection, the external-key index, and
the work-correlation index. It does not accept commands and does not decide
whether a discovery or correlation is valid — that is the aggregate's
responsibility; this component only reflects facts the aggregate already
accepted. It does not resolve which of several Resources under the same
external key is canonical beyond first-discovered-wins (see below).

Its `primaryCorrelation(resourceId)` query is history-aware without exposing
Resource stream folding to consumers: it returns an active primary correlation
when one exists; otherwise it returns the most recently retracted primary
correlation. Callers that need lifecycle-sensitive handling must query Work
for that correlation's current state.

## Core policies, invariants, and behaviours

- Each projection MUST be derivable purely by replaying `resources.*` facts
  from the beginning of the journal; none of them MUST depend on any state
  outside that fact stream.
- The external-key index MUST map an external key to the `ResourceId` of the
  first Resource ever discovered under it. A later discovery fact using the
  same external key but a different `ResourceId` MUST NOT change the index
  entry: the index is first-discovered-wins per external key, permanently.
  The index key MUST be derived so two distinct `(adapter, key)` pairs never
  collide, even when the adapter or key value itself contains the separator
  used to combine them.
- The per-`ResourceId` summary projection MUST reflect the most recently
  observed kind, external key, capabilities, and revision from that
  Resource's discovery and revision facts, and the most recently recorded
  correlation conflict. Unlike the aggregate's own fold, this projection
  updates its kind, external key, and capabilities from every subsequent
  discovery fact, not only the first.
- The per-`ResourceId` correlation-list projection and the work-correlation
  index MUST each add one entry the first time a `WorkItemId` (respectively
  a `ResourceId`) is established against the other, and MUST remove that
  entry on a matching retraction. Neither projection MUST update an existing
  entry's role when a later establishment fact re-affirms the same pair
  under a different role: each keeps the role recorded by the first
  establishing fact for that pair.
- A query against Resource lookup MUST reflect every fact currently in the
  journal, not only facts already folded into a stored checkpoint: a query
  MUST read the stored projection value and then fold any journal events
  beyond its checkpoint before answering, so a caller observes its own
  immediately preceding writes regardless of background projection timing.

## Event catalogue

Resource lookup reacts to the full `resources.*` event catalogue (see the
module specification); it emits none of its own. `resources.resource-discovered`
seeds the external-key index and the summary projection.
`resources.resource-revision-observed` and `resources.work-correlation-conflicted`
update the summary projection. `resources.work-correlation-established` and
`resources.work-correlation-retracted` update the two correlation-list
projections.

## Conceptual schema

**Resource summary** (per `resourceId`)

| Field | Type | Description |
| --- | --- | --- |
| `resourceId` | Resource identity | The projection's key. |
| `kind` | vocabulary value | Overwritten by every accepted discovery fact for this `resourceId`. |
| `externalKey` | `{ adapter, key }` pair | Overwritten by every accepted discovery fact for this `resourceId`. |
| `capabilities` | list of vocabulary value | Overwritten by every accepted discovery fact for this `resourceId`. |
| `revision` | optional string | Set by discovery if given; updated by each revision fact. |
| `title` | optional string | Set by discovery if given; a later discovery fact for the same `resourceId` updates it as given, or drops it if that fact omits it. |
| `primaryCorrelationConflict` | optional conflict record | Replaced wholesale by each conflict fact. |

**External-key index entry**

| Field | Type | Description |
| --- | --- | --- |
| key | URI-component-encoded `adapter:key` string | Derived from a Resource's external key; each component is encoded before joining so a colon inside an adapter or key value cannot be mistaken for the separator. |
| value | Resource identity or absent | The `ResourceId` first discovered under this external key; absent until a discovery fact for it exists. |

**Resource correlation** (per `resourceId` and, mirrored, per `workItemId`)

| Field | Type | Description |
| --- | --- | --- |
| `resourceId` | Resource identity | The correlated Resource. |
| `workItemId` | WorkItem identity | The correlation's target. |
| `role` | closed vocabulary: `primary` / `secondary` | The role recorded by the first establishing fact for this pair. |
| `establishedByEventId` | event identity | The first establishing fact for this pair. |

## Dependencies and system role

- Kernel — projection definition, projection store, and event journal
  conventions; how Resource lookup is registered, checkpointed, and rebuilt.
- Resource (depends on it) — the aggregate whose accepted `resources.*` facts
  this component folds; Resource lookup never writes to a Resource stream.
- Resource application boundary (depends on Resource lookup) — the only
  caller of its two queries (`resourceIdForExternalKey`, `correlationsForWork`),
  used to implement `findByExternalKey` and `correlationsForWork`.
- Integrations (depends on Resource lookup indirectly, through the
  application boundary) — looks a Resource up by external key to decide
  whether an incoming provider event describes a Resource Wake already
  knows.
- Control-plane and execution (depend on Resource lookup indirectly) — look
  up the Resources correlated to a WorkItem to hand to execution and
  activities on each advance.

## Decisions, exclusions, and deferred capability

- The external-key index and the two correlation-list projections are
  first-write-wins by design of their current fold; a Resource discovered a
  second time under the same external key, or a correlation re-established
  under a changed role, does not move the index or update the recorded role.
  This differs from the Resource aggregate's own fold (see
  `../domain/resource.spec.md`), which is last-write-wins for a correlation's
  role.
