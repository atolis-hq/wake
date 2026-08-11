# Resource — Component Specification

## Type, purpose, and scope

Aggregate. Resource is the stream-owning aggregate for a single external
provider object identified by a `ResourceId`. It is the sole authority on
whether a discover, revision, correlate, or retract command against that
identity is accepted, and it is the source of every `resources.*` fact
recorded for that identity.

## Responsibilities and boundaries

Resource owns discovery acceptance, revision recording, and correlation and
retraction acceptance/rejection for its own identity, including detecting and
recording a conflicting primary correlation attempt. It does not validate a
correlation's target `WorkItemId` — it accepts and records the identity as
given, without requiring the WorkItem to exist. It does not decide when a
caller should discover, correlate, or retract; it only enforces whether the
command it receives is currently valid.

## Core policies, invariants, and behaviours

**Identity and discovery**

- A `ResourceId` MUST already be Wake-minted (matches Wake's own identity
  format) before a discovery command is accepted. Resource does not derive
  identity from the external key.
- Discovering a `ResourceId` for the first time MUST establish it with the
  given kind, external key, capabilities, and (if given) revision and title.
- Discovering a `ResourceId` that already exists MUST be accepted, but MUST
  NOT change the Resource's recorded kind, external key, capabilities,
  revision, or title: the first-recorded discovery remains canonical for this
  aggregate's own view. A repeat discovery is therefore observably a no-op
  even though it is accepted rather than rejected.

**Existence gating**

- A correlate command against a `ResourceId` that has never been discovered
  MUST be rejected.
- Retracting a correlation MUST be accepted regardless of whether the
  Resource has ever been discovered or whether an active correlation for the
  named `WorkItemId` currently exists. Retraction against a Resource with no
  prior discovery, or against a `WorkItemId` with no active correlation, has
  no observable effect: a Resource's own view does not exist at all until a
  discovery fact anchors it, and there is no correlation entry to remove.

**Correlation and conflict**

- A role MUST be either `primary` or `secondary`.
- Establishing a `secondary` correlation MUST always be accepted; Resource
  does not limit how many secondary correlations a Resource carries.
- Establishing a `primary` correlation MUST be accepted when the Resource
  currently has no active primary correlation, or when its active primary
  correlation already names the same `WorkItemId`.
- Establishing a `primary` correlation naming a `WorkItemId` different from
  the Resource's existing active primary correlation MUST be rejected. The
  rejected attempt MUST be recorded as a conflict fact carrying both the
  attempted and the existing `WorkItemId`, and the existing primary
  correlation MUST remain unchanged. A conflict fact replaces any earlier
  recorded conflict for this Resource; only the most recent conflict is
  retained in the view.
- Re-establishing a correlation for a `WorkItemId` that already has an
  active correlation on this Resource, under a new role, MUST be accepted
  (subject to the primary-uniqueness rule above): the aggregate's view of
  that `WorkItemId`'s correlation reflects the most recently established
  role.
- Retracting a `WorkItemId`'s correlation MUST remove it from the Resource's
  active correlations. It does not affect any recorded conflict fact.

**Command identity**

- Replaying the exact same command MUST NOT change observable state beyond
  what the first acceptance already produced: a command's acceptance is
  idempotent by the command's own identity, independent of the
  Resource-level rules above.

## Event catalogue

| Event | Recorded when | Meaning |
| --- | --- | --- |
| `resources.resource-discovered` | A discovery command is accepted | This `ResourceId` now denotes a known, provider-neutral Resource with the given kind, external key, capabilities, and optional revision and title. Recorded on every accepted discovery, including repeats, though only the first is canonical. |
| `resources.resource-revision-observed` | A revision command is accepted | The Resource's observed content marker has moved to the new value. |
| `resources.work-correlation-established` | A correlate command is accepted | A correlation of the given role now exists from this Resource to the named `WorkItemId`. |
| `resources.work-correlation-retracted` | A retract command is accepted | The named `WorkItemId`'s correlation to this Resource, if any, no longer exists. |
| `resources.work-correlation-conflicted` | A `primary` correlate command names a `WorkItemId` different from the existing primary | An attempted primary correlation disagreed with the Resource's canonical primary; the attempt is rejected and the disagreement is now a durable fact. |

## Conceptual schema

Resource state is the fold of its own `resources.*` facts, keyed by
`resourceId`. This fold anchors on the first `resources.resource-discovered`
fact; a stream with no such fact folds to no Resource at all.

| Field | Type | Description |
| --- | --- | --- |
| `resourceId` | Wake-minted identity | The stream's identity; every fact in the stream MUST belong to it. |
| `kind` | vocabulary value | Set by the first discovery fact; unaffected by any later discovery fact. |
| `externalKey` | `{ adapter, key }` pair | Set by the first discovery fact; unaffected by any later discovery fact. |
| `capabilities` | list of vocabulary value | Set by the first discovery fact; unaffected by any later discovery fact. |
| `revision` | optional string | Set by the first discovery fact if given; updated by each accepted revision fact. |
| `title` | optional string | Set by the first discovery fact if given; unaffected by any later discovery fact. |
| `primaryCorrelationConflict` | optional conflict record | Absent until the first conflict fact; replaced wholesale by each subsequent conflict fact. |
| `correlations` | list of `Resource correlation` entry | Starts empty; gains or updates one entry per distinct `workItemId` established, keyed by `workItemId`, and loses an entry on retraction. |

**Resource correlation** (child entity, this aggregate's own fold)

| Field | Type | Description |
| --- | --- | --- |
| `resourceId` | Resource identity | This Resource. |
| `workItemId` | WorkItem identity | The correlation's target, as given; Resource does not verify it exists. |
| `role` | closed vocabulary: `primary` / `secondary` | Reflects the most recently established role for this `workItemId`. |
| `establishedByEventId` | event identity | The most recent establishing fact for this `workItemId`. |

## Dependencies and system role

- Kernel — event/stream conventions for reading and appending its own
  single-identity stream; Resource's only dependency for its write path.
- Work (depends on it indirectly) — defines the `WorkItemId` identity format
  a correlation's target must satisfy; Resource does not call into Work.
- Resource lookup (depends on Resource) — folds the same `resources.*` facts
  into cross-Resource read models; Resource does not depend back on it.
- Resource application boundary (depends on Resource) — the only caller that
  loads, decides against, and appends to a Resource stream; no other module
  reads or writes `resources.*` facts directly.

## Decisions, exclusions, and deferred capability

- There is no command to revise a Resource's kind, external key, or
  capabilities once discovered; a change in what a provider object
  fundamentally is or supports is not modeled as an update to an existing
  Resource.
- The revision command and event are modeled in this fold, but the Resource
  application boundary does not currently issue them from any exposed
  operation.
- Resource does not validate that a correlation's `WorkItemId` exists or is
  open; that is left to the caller (or to a future cross-module check).
