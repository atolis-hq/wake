---
asOf: 31cb84460b6099ea50edc17a70d3ec679ba08cc5
---

# Kernel — Module Specification

## Purpose and scope

Kernel defines the universal, domain-free primitives every other Wake module
builds its own behaviour on top of: the shape of a durable event (draft and
envelope), the ports through which events and read models are stored and
read, identifier branding and identity-minting conventions, the
closed-vocabulary pattern for declaring bounded value sets, and the relation
primitive used to connect two identified entities. Kernel owns no business
behaviour, no event types of its own, and no workflow or lifecycle state.

## Responsibilities and boundaries

Kernel owns:

- The event draft and event envelope shape, and the rules for constructing a
  valid draft.
- The storage and time ports every other module programs against:
  `EventJournal` (append/readStream/readAll, plus an optional `readLatest`
  for backward reads), `ProjectionStore` (read/write/list/clear),
  `CheckpointStore` (load/save/reset), `Clock`, `IdGenerator`.
- Identifier branding conventions (`Brand<T, Name>`, `EventId`,
  `CorrelationId`, `CausationId`) and the `EntityRef` shape used to address
  any stream or related entity by kind and id.
- The closed-vocabulary convention (`defineClosedVocabulary`, `ValueOf`) that
  other modules use to declare their own bounded value sets (statuses,
  kinds, relation names, and similar), plus one shared generic vocabulary
  (`MatchMode`) and its list-matching evaluation rule.
- The `Relation` / `RelationDefinition` primitive: a named, kind-checked
  directed connection between two `EntityRef`s.
- Reference infrastructure for the ports above that has no module-specific
  behaviour: `SystemClock`, `UlidIdGenerator`.

Kernel does not own:

- Any domain event type, aggregate, projection, or policy. Kernel's own
  namespace declarations for events, config, relations, and streams are all
  empty; every concrete event type belongs to the module that emits it.
- Concrete durable storage. Kernel defines `EventJournal`, `ProjectionStore`,
  and `CheckpointStore` as ports only; a backing implementation is supplied
  elsewhere and wired in at composition time.
- Command validation or business rules. `CommandContext` is a shared shape
  passed into a module's own aggregate, not a command handler.
- Deriving a command's own identity into a deterministic `eventId`. That
  mapping — and any command-level replay idempotency built on it — is each
  module's own aggregate's decision; kernel only guarantees what happens at
  the journal once such an `eventId` is submitted (see Append idempotency
  below).

## Ubiquitous language

- **Event draft** — an event not yet appended to a stream: `eventId`,
  `eventType`, `schemaVersion` (fixed at `1`), `occurredAt`, `correlationId`,
  `causationId`, `actor`, `source`, `stream`, and `payload`.
- **Event envelope** — an event draft that has been accepted and appended,
  with `recordedAt`, `sequence`, and `globalPosition` added by the journal.
- **Stream** — the strictly ordered sequence of event envelopes belonging to
  one `EntityRef`.
- **EntityRef** — a `{ kind, id }` pair addressing any stream or related
  entity; `kind` is a discriminant string a module chooses for its own
  identity kind, `id` is that entity's own identity value.
- **Actor** — who or what caused an event: `system`, `operator`, `agent`, or
  `integration` (`EventActorKind`), each carrying an `id`.
- **Source** — where an event entered Wake: `internal` (produced by Wake's
  own logic) or `adapter` (translated from an external provider)
  (`EventSourceKind`).
- **Correlation id** — a branded identifier threading every event and
  command belonging to one flow together.
- **Causation id** — a branded identifier naming the specific event or
  command that immediately triggered another.
- **Branded identifier** — a plain runtime string carrying a compile-time
  brand (`Brand<T, Name>`) so identifiers of different kinds cannot be
  interchanged by the type system, even though at runtime they remain
  ordinary strings.
- **Closed vocabulary** — a frozen, named set of string constants declared
  through `defineClosedVocabulary`; code compares against these named
  constants, never against an inline string literal that duplicates one.
- **Relation** — a directed, named connection from one `EntityRef` to
  another, constrained by a `RelationDefinition` that fixes which entity
  kind may occupy each end.
- **Checkpoint** — a named consumer's last-processed `globalPosition`, used
  to resume forward-only replay of the journal.
- **Stored projection** — a namespaced, keyed read-model value together with
  the `globalPosition` it was last folded up to.
- **Command context** — the shared shape (`commandId`, `correlationId`,
  `actor`, `occurredAt`) a module's surface application passes to its own
  aggregate when translating an accepted command into event drafts.

## Core policies, invariants, and behaviours

**Event draft construction**

- Constructing an event draft MUST reject an empty `eventType`.
- Constructing an event draft MUST reject an `occurredAt` that is not a
  valid offset ISO-8601 timestamp.
- Constructing an event draft MUST reject an empty `actor.id` or
  `source.id`.
- Constructing an event draft MUST brand `eventId`, `correlationId`, and
  `causationId` through their identifier constructors, which MUST reject an
  empty string.
- Every event draft and envelope carries `schemaVersion: 1`; kernel defines
  no migration or version-negotiation behaviour on top of it (see
  Decisions).

**Stream identity and ordering**

- Every event submitted in one append call MUST target the same stream as
  the call itself; an append MUST reject a batch containing an event whose
  own `stream` disagrees with the stream the call was made against.
- `sequence` MUST start at `1` for the first event ever appended to a
  stream and MUST increase by exactly `1` for each subsequent event
  appended to that same stream, with no gaps.
- `globalPosition` MUST start at `1` for the first event ever appended to
  the journal, across all streams, and MUST increase by exactly `1` for
  each subsequently appended event — giving the whole journal one strict
  serial order independent of which stream an event belongs to.
- Append MUST be optimistic-concurrency controlled by `expectedSequence`:
  the caller states the stream length it believes currently exists: when
  the stream's actual current length differs, append MUST be rejected and
  MUST NOT record any of the submitted events.

**Append idempotency**

This is the guarantee every module's aggregate relies on to make its own
command handling safe to retry.

- Each event submitted to `append` is identified by its own `eventId`.
  Resubmitting a draft whose `eventId` is already recorded, with content
  identical to what was previously recorded, MUST NOT create a duplicate
  event and MUST return the previously recorded envelope for that
  `eventId`.
- Resubmitting a draft whose `eventId` is already recorded but whose
  content differs from what was previously recorded MUST be rejected: an
  `eventId`, once used, MUST NOT be reused for a different event.
- When every event submitted in one `append` call is already recorded under
  its `eventId` with identical content, the whole call MUST be accepted as
  a no-op returning the original envelopes, without re-validating
  `expectedSequence` against the stream's current length. This is what
  makes a whole append safe to retry verbatim after a caller cannot tell
  whether its previous attempt was recorded.
- Within a single `append` call, the same `eventId` MUST NOT be submitted
  more than once, even with identical content twice — a batch MUST be
  internally unique by `eventId`.
- When only some of a call's `eventId`s are already recorded and others are
  genuinely new, `append` MUST validate `expectedSequence` against the
  stream's actual current length, MUST record only the new events, and
  MUST return the previously recorded envelopes unchanged for the ones that
  already existed.

**Reading**

- `readStream` MUST return a stream's events in their recorded `sequence`
  order.
- `readAll` MUST return only events with `globalPosition` strictly greater
  than the given cursor, in increasing `globalPosition` order, honouring an
  optional result limit — this is what lets a checkpointed consumer resume
  a forward-only replay of the whole journal.
- `readLatest` is an optional `EventJournal` capability; a journal MAY leave
  it unimplemented. When implemented, it MUST return only events with
  `globalPosition` strictly less than the given cursor (or every event, when
  the cursor is omitted), in decreasing `globalPosition` order, honouring an
  optional result limit — this is what lets a consumer read backward from
  the most recent event without scanning the whole journal forward first.

**Checkpoints and stored projections**

- A checkpoint is scoped by consumer name; `load` for a consumer that has
  never saved a checkpoint MUST return a position representing "nothing
  processed yet" rather than failing.
- `save` MUST reject a `globalPosition` lower than the consumer's
  currently loaded checkpoint: a checkpoint MUST NOT move backward.
- A stored projection is addressed by `(namespace, key)`; `write` MUST
  replace any prior value at that address, and the `lastGlobalPosition` it
  carries is the caller's own record of how far that value reflects the
  journal — kernel does not derive or validate this figure itself.
- `read` for an address with no stored value MUST return `null` rather than
  failing. `clear` MUST remove every entry in the given namespace, or every
  entry across all namespaces when called without one.

**Identifiers and identity minting**

- `IdGenerator.next(prefix)` MUST reject a `prefix` that is not
  lowercase-letter-led and restricted to lowercase letters, digits, and
  hyphens thereafter.
- A generated id MUST take the form `<prefix>-<ulid>`, entirely lowercase.
  This is Wake's own identity format: a module's own branded identity type
  (e.g. a `WorkItemId`) validates that a value matches this shape before
  accepting it as genuine.
- `EventId`, `CorrelationId`, and `CausationId` MUST be non-empty strings;
  kernel brands them at the type level so they cannot be substituted for
  each other, or for a plain string, by the type system — the brand carries
  no runtime representation beyond the string itself.
- A kernel branded-identifier constructor only guarantees non-emptiness; it
  does not guarantee uniqueness, and (other than the generated-id format
  above) does not guarantee any particular shape.

**Closed vocabulary**

- A closed vocabulary MUST be declared once through `defineClosedVocabulary`
  and compared by its named constants; production code MUST NOT compare a
  vocabulary field against an inline string literal that duplicates one of
  its values.
- `MatchMode` (`any` / `all`) governs matching a required list of values
  against an observed list: an empty required list MUST match
  unconditionally, regardless of mode. A non-empty required list under
  `all` MUST match only when every required value is present in the
  observed set; under `any` it MUST match when at least one required value
  is present.
- `MatchMode` governs matching within one list only. A caller that needs
  "this list AND that list" MUST evaluate each required list separately and
  combine the results — kernel does not provide a combinator across lists.

**Relations**

- Constructing a `Relation` MUST reject a `from` whose `kind` does not equal
  its `RelationDefinition.fromKind`, or a `to` whose `kind` does not equal
  its `toKind`.
- A `Relation` MUST record the `eventId` that established it
  (`establishedByEventId`); kernel defines no operation to remove or amend
  an established relation — that lifecycle question, if a module needs it,
  belongs to the module that owns the relation kind.

## Conceptual schema

**EventDraft**

| Field | Type | Description |
| --- | --- | --- |
| `eventId` | branded `EventId` | Identity of this event; governs append idempotency. |
| `eventType` | string, non-empty | The owning module's own closed-vocabulary event type name. |
| `schemaVersion` | literal `1` | Fixed; kernel defines no other value yet. |
| `occurredAt` | offset ISO-8601 timestamp | When the fact became true in the world, as stamped by the producer. |
| `correlationId` | branded `CorrelationId` | Groups every event/command belonging to one flow. |
| `causationId` | branded `CausationId` | Names the event or command that immediately triggered this one. |
| `actor` | Actor | Who or what caused this event. |
| `source` | Source | Whether this event originated internally or via an adapter. |
| `stream` | EntityRef | The stream this event belongs to. |
| `payload` | module-defined | The event's own data; opaque to kernel. |

**EventEnvelope** (extends EventDraft)

| Field | Type | Description |
| --- | --- | --- |
| `recordedAt` | offset ISO-8601 timestamp | When the journal accepted the append; set by the journal, not the caller. |
| `sequence` | positive integer | This event's 1-based position within its own stream. |
| `globalPosition` | positive integer | This event's 1-based position within the whole journal, across all streams. |

**Actor**

| Field | Type | Description |
| --- | --- | --- |
| `kind` | closed vocabulary: `system` / `operator` / `agent` / `integration` | Category of who or what caused the event. |
| `id` | string, non-empty | Identity of that actor within its kind. |

**Source**

| Field | Type | Description |
| --- | --- | --- |
| `kind` | closed vocabulary: `internal` / `adapter` | Whether the event was produced by Wake's own logic or translated from an external provider. |
| `id` | string, non-empty | Identity of the specific internal producer or adapter. |

**EntityRef**

| Field | Type | Description |
| --- | --- | --- |
| `kind` | string | Discriminant a module chooses for its own identity kind. |
| `id` | string | That entity's own identity value within its kind. |

**CommandContext**

| Field | Type | Description |
| --- | --- | --- |
| `commandId` | string, unbranded | The command's own identity, as given by its caller; kernel does not derive event identity from this itself. |
| `correlationId` | branded `CorrelationId` | Flow this command belongs to. |
| `actor` | Actor | Who or what issued the command. |
| `occurredAt` | offset ISO-8601 timestamp | When the command was issued. |

**RelationDefinition**

| Field | Type | Description |
| --- | --- | --- |
| `owner` | string | The module that defines this relation kind. |
| `name` | string | The relation's own closed-vocabulary name, defined by its owning module. |
| `fromKind` | string | Required `EntityRef.kind` at the relation's `from` end. |
| `toKind` | string | Required `EntityRef.kind` at the relation's `to` end. |

**Relation**

| Field | Type | Description |
| --- | --- | --- |
| `relationId` | string | Identity of this specific relation instance. |
| `definition` | RelationDefinition | The relation kind this instance is of. |
| `from` | EntityRef | The relation's source entity; `kind` must match `definition.fromKind`. |
| `to` | EntityRef | The relation's target entity; `kind` must match `definition.toKind`. |
| `establishedByEventId` | string | The event that brought this relation into existence. |

**StoredProjection**

| Field | Type | Description |
| --- | --- | --- |
| `namespace` | string | Groups related projection entries, typically one per projection. |
| `key` | string | Identity of this entry within its namespace. |
| `lastGlobalPosition` | positive integer | The journal position the caller last folded this value up to. |
| `value` | module-defined | The projection's own read-model value; opaque to kernel. |

## Child components and interactions

Kernel owns no aggregate, projection, policy/process, adapter, or surface
application in the module sense used elsewhere in this system: it defines no
stream of its own, decides nothing, and translates nothing across an
external boundary. Its content is a set of primitives and port contracts
that other modules' components are built from, so it is fully captured at
this module-page level rather than split into child component pages. The
pieces above are best read as a map, not a component table:

| Primitive or port | Role |
| --- | --- |
| Event draft / envelope | The universal shape every module's own event types instantiate. |
| `EventJournal` | The append/read port a module's aggregate and projections are built against. |
| `ProjectionStore` | The read-model storage port a module's projection writes to and reads from. |
| `CheckpointStore` | The replay-cursor port a projection or process uses to resume forward-only. |
| `Clock` / `IdGenerator` | The time and identity-minting ports modules depend on instead of calling `Date`/`ulid` directly. |
| Branded identifiers / `EntityRef` | The addressing and identity-typing conventions every stream and relation uses. |
| Closed vocabulary / `MatchMode` | The pattern for declaring bounded value sets, plus one shared generic matching rule. |
| `Relation` / `RelationDefinition` | The primitive a module uses to declare and validate a named connection between two entity kinds. |

## Dependencies and system role

- `zod` — validates event envelope/draft shape and timestamp format at the
  schema boundary (`event-schema.ts`, `schema.ts`).
- `ulid` — generates the random, sortable component of a minted identity in
  `UlidIdGenerator`.
- Every other Wake module (`work`, `orchestration`, `execution`,
  `resources`, `activities`, `control-plane`, `integrations`,
  `persistence`) — depends on kernel for its event envelope, identifier
  branding, `EntityRef`, closed-vocabulary, and port types; each module
  defines its own event types and streams on top of these primitives.
  Kernel imports no Wake module in return; the dependency runs one way.
- `persistence` (depends on kernel) — supplies the concrete backing
  implementations of kernel's `EventJournal`, `ProjectionStore`, and
  `CheckpointStore` ports that are wired in at composition time.

## Decisions, exclusions, and deferred capability

- Kernel defines no schema versioning or migration policy beyond the fixed
  `schemaVersion: 1` literal; evolving an event's payload shape across
  versions is not yet a kernel capability.
- Kernel does not model relation removal or amendment — only establishment
  is represented (`establishedByEventId`). A module that needs a mutable or
  revocable relation builds that behaviour itself, on top of this
  primitive.
- `CommandContext.commandId` is deliberately unbranded and kernel does not
  derive event identity from it. Deriving a deterministic `eventId` from a
  command's own identity — the mechanism that lets a whole command's
  acceptance be idempotent by the command's own identity — is left to each
  module's aggregate; kernel's contribution is guaranteeing that the
  journal treats a resubmitted `eventId` and content pair as a no-op once
  that derivation has been made.
- `IdGenerator` does not track or reserve prefixes across modules; avoiding
  a prefix collision between two modules' identity kinds is a naming
  convention the modules themselves are expected to follow, not an
  invariant kernel enforces.
- Kernel ships exactly one concrete `Clock` and one concrete `IdGenerator`
  (`SystemClock`, `UlidIdGenerator`) as reference infrastructure alongside
  the ports; it does not itself provide a deterministic or fake
  implementation of either.
