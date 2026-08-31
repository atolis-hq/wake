---
asOf: 5031f5b26b684460a94bb1b97599813cc14c5926
---

# Kernel — Module Specification

## Purpose and scope

Kernel owns stable, domain-neutral primitives shared by Wake bounded modules:
time and identity ports, generic branded identifiers and entity references,
relations, schema helpers, and closed vocabularies. It owns no event contracts,
durable storage ports, domain facts, or policy.

## Responsibilities and boundaries

Kernel owns:

- `Clock` and `IdGenerator` ports, with system-clock and ULID implementations.
- `Brand` and `EntityRef` structural identity conventions.
- `Relation` and `RelationDefinition`, including kind-checked construction.
- Closed-vocabulary helpers, the generic `MatchMode` vocabulary, and matching.
- Zod helpers for timestamp and branded-string validation.

Kernel does not own:

- Event data, envelopes, event identifiers, journals, checkpoints,
  projections, processor state, or processor runtime. Those belong to
  `@atolis-hq/eventing`.
- Filesystem adapters. `@atolis-hq/eventing-filesystem` implements Eventing
  ports and Bootstrap composes those adapters.
- Domain event types, aggregate policy, workflow state, provider integration,
  or configuration.

## Ubiquitous language

- **Branded identifier** — a runtime string with a compile-time brand that
  prevents incompatible identities being exchanged by the type system.
- **Entity reference** — a `{ kind, id }` pair that identifies a domain entity.
- **Closed vocabulary** — a named, frozen set of string values compared through
  its exported members.
- **Match mode** — whether all or any required values must be present.
- **Relation** — a directed, named, kind-checked connection between entities.

## Core policies, invariants, and behaviours

- `IdGenerator.next(prefix)` MUST reject a prefix that is not lowercase-letter
  led and then composed only of lowercase letters, digits, and hyphens. Its
  generated values MUST be lowercase `<prefix>-<ulid>` strings.
- A branded identifier conveys no runtime representation beyond its source
  string. A module MUST apply any additional format or ownership validation its
  own identity needs.
- A closed vocabulary MUST be declared once and compared through exported
  values, rather than replicated magic strings.
- An empty required-value list MUST match regardless of `MatchMode`; `all`
  requires each required value and `any` requires at least one.
- Creating a relation MUST reject a `from` or `to` entity whose kind does not
  match the relation definition. Kernel provides no relation amendment or
  removal operation.

## Conceptual schema

**Entity reference**

| Field | Type | Description |
| --- | --- | --- |
| `kind` | non-empty domain discriminator | The owner's entity kind. |
| `id` | owner-defined identity | The identity within that kind. |

**Relation definition**

| Field | Type | Description |
| --- | --- | --- |
| `owner` | string | Module that defines the relation kind. |
| `name` | string | Closed-vocabulary relation name. |
| `fromKind` | string | Required source entity kind. |
| `toKind` | string | Required target entity kind. |

**Relation**

| Field | Type | Description |
| --- | --- | --- |
| `relationId` | string | Identity of this relation instance. |
| `definition` | Relation definition | The kind and endpoint constraints. |
| `from` | Entity reference | Source endpoint. |
| `to` | Entity reference | Target endpoint. |
| `establishedByEventId` | Eventing event identifier string | Durable fact that established the relation. |

## Child components and interactions

Kernel has no aggregate, projection, processor, adapter, or surface. Its
exported primitives are consumed through `src/kernel/index.ts`; Eventing's
structurally compatible stream and event contracts remain in its own package.

## Dependencies and system role

- `zod` — schema validation helpers.
- `ulid` — sortable identity generation.
- Bounded Wake modules — consume generic Kernel primitives where no Eventing or
  domain-owned contract is more precise.
- `@atolis-hq/eventing` — independently owns event contracts and runtime; it
  has no dependency on Kernel.
- Bootstrap — composes Kernel implementations with Eventing and filesystem
  adapter implementations.

## Decisions, exclusions, and deferred capability

- Kernel deliberately has no event, configuration, stream, or relation
  namespace of its own.
- It does not reserve identifier prefixes or prove identifier uniqueness.
- It supplies only system implementations for time and identity generation;
  deterministic fakes remain test infrastructure.
