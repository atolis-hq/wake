---
asOf: 570f5327a406b1993562cbe0e6b47e239b8827ee
---

# Resources — Module Specification

## Purpose and scope

Resources owns the canonical, provider-neutral identity of an object Wake
observes in an external provider — a GitHub issue, pull request, repository,
or equivalent — and the explicit act of correlating that identity to a
WorkItem. It exists so every other module reasons about "the external thing
this WorkItem is about" through one identity and read model, instead of each
module parsing provider payloads or provider URLs for itself.

## Responsibilities and boundaries

Resources owns:

- Resource identity, its declared kind, capabilities, and observed revision.
- Correlating a Resource to a `WorkItemId` under an explicit role, and
  recording — not silently resolving — a conflicting correlation attempt.
- Read models for finding a Resource by its external key and for finding the
  Resources currently correlated to a given `WorkItemId`.

Resources does not own:

- Provider payload shape or translation. Turning provider evidence into a
  `discover`/`correlate` command is an adapter's responsibility, outside this
  module.
- `WorkItemId` minting or Work's own lifecycle. Resources correlates to a
  `WorkItemId` it did not mint and never creates or transitions a WorkItem
  itself.
- Deciding workflow routing, which activities run, or Activity-level policy.
  Other modules read Resource state to make those decisions; Resources does
  not make them.

## Ubiquitous language

- **Resource** — the identity-bearing record of one external provider object.
- **Kind** — what a Resource is (e.g. repository, issue, pull request); a
  vocabulary value, extensible beyond the built-in set.
- **Capability** — what a Resource supports (e.g. commentable, reviewable,
  approvable, mergeable, revisioned, editable, has changed-files evidence); a
  vocabulary value, extensible beyond the built-in set.
- **External key** — the `(adapter, key)` pair identifying a Resource inside
  its own provider; the provider-owned, untrusted identity a Resource is
  discovered from.
- **Revision** — an opaque marker for a Resource's current version or content
  (e.g. a commit SHA), as observed from the provider.
- **Correlation** — a fact linking a Resource to a `WorkItemId` under a role.
- **Primary correlation** — a Resource's canonical WorkItem; at most one is
  active at a time.
- **Secondary correlation** — a non-canonical link from a Resource to a
  `WorkItemId`, alongside (or instead of) a primary correlation.
- **Correlation conflict** — the recorded fact that an attempted primary
  correlation named a different `WorkItemId` than the one already primary;
  the attempt is rejected, but the disagreement itself is preserved as
  evidence.

## Core policies, invariants, and behaviours

- A Resource's kind and capabilities MUST describe what it abstractly is and
  supports, not which provider emitted it; no downstream module MUST need to
  branch on adapter identity to interpret them.
- A Resource MUST be correlated only by an explicit command that names both
  the Resource and the target `WorkItemId`; correlation is never inferred
  from co-occurrence or naming.
- A Resource MUST have at most one active primary correlation at a time. An
  attempt to establish a second, disagreeing primary correlation MUST be
  rejected and MUST be recorded as a distinct conflict fact rather than
  silently dropped or silently overwriting the existing primary.
- Secondary correlations are not limited to one per Resource.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `resources.resource-discovered` | A Resource identity is first recorded | This external object is now a known, provider-neutral Resource with a kind, external key, and capabilities. |
| `resources.resource-revision-observed` | A new revision marker is recorded for a Resource | The Resource's provider-side content has moved on to a new observed version. |
| `resources.work-correlation-established` | A correlation command is accepted | The Resource is now correlated to the named `WorkItemId` under the given role. |
| `resources.work-correlation-retracted` | A retraction command is accepted | The Resource is no longer correlated to the named `WorkItemId`. |
| `resources.work-correlation-conflicted` | A primary correlation attempt names a `WorkItemId` different from the existing primary | An untrusted correlation attempt disagreed with the Resource's canonical primary; the disagreement is now a durable fact, and the canonical primary is unchanged. |

## Conceptual schema

**Resource**

| Field | Type | Description |
| --- | --- | --- |
| `resourceId` | Wake-minted identity | Identity of the external object; never derived from the external key. |
| `kind` | closed-vocabulary-like value (built-in: `repository` / `issue` / `pull-request`) | What the Resource is. |
| `externalKey` | `{ adapter, key }` pair | The provider-owned identity the Resource was discovered from. |
| `capabilities` | list of vocabulary value (built-in: commentable, reviewable, approvable, mergeable, revisioned, editable, changed-files) | What the Resource supports. |
| `revision` | optional string | The most recently observed provider-side content marker. |
| `primaryCorrelationConflict` | optional conflict record | Present only after a rejected, disagreeing primary correlation attempt; holds the attempted and existing `WorkItemId`. |

**Resource correlation**

| Field | Type | Description |
| --- | --- | --- |
| `resourceId` | Resource identity | The correlated Resource. |
| `workItemId` | WorkItem identity (owned by Work) | The target of the correlation; Resources does not require it to exist. |
| `role` | closed vocabulary: `primary` / `secondary` | How this correlation participates in the Resource's canonical WorkItem link. |
| `establishedByEventId` | event identity | The fact that established this correlation entry. |

## Child components and interactions

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [Resource](domain/resource.spec.md) | aggregate | Resource identity, discovery, revision, correlation and conflict acceptance/rejection for its own stream | Produces the `resources.*` facts that Resource lookup projects and that other modules correlate against. |
| [Resource lookup](application/resource-lookup.spec.md) | projection | The Resource-by-external-key index and the Resource-correlation read models | Rebuilds purely from `resources.*` facts; answers queries the aggregate's own stream cannot answer alone (cross-Resource, by external key or by `WorkItemId`). |
| Resource application boundary | surface application | Validating and routing discover/correlate/retract commands to the aggregate, and exposing `get`/`findByExternalKey`/`correlations`/`correlationsForWork` queries | The only path by which a command reaches the Resource aggregate or a caller reaches Resource lookup; no other module folds `resources.*` facts directly. |

## Dependencies and system role

- Kernel — event journal, envelope, projection, and relation conventions;
  Resources' foundation for its own stream and read models.
- Work (Resources depends on it) — supplies the `WorkItemId` identity and
  format that a correlation targets; Resources never mints or transitions a
  WorkItem.
- Integrations (depends on Resources) — discovers Resources from provider
  evidence and correlates them to a WorkItem as part of admitting observed
  work, and looks a Resource up by external key to decide whether an
  incoming provider event is new or already known.
- Execution (depends on Resources) — selects the repository-kind Resource to
  acquire a workspace, and validates an Activity's declared resource
  requirements against correlated Resources' capabilities.
- Activities (depends on Resources) — gates pull-request review, approval,
  and merge authority on Resource capabilities and on whether a Resource
  currently carries a primary correlation conflict.
- Control-plane (depends on Resources) — gathers the Resources currently
  correlated to a WorkItem to hand to execution and activities on each
  advance.
- Bootstrap and surfaces (depend on Resources) — wire the Resource
  application boundary into the composition root and present Resource and
  correlation state through the CLI and API.

## Decisions, exclusions, and deferred capability

- `resources.resource-revision-observed` is fully modeled in the aggregate's
  fold and in the projections, but the Resource application boundary does
  not currently expose a command to issue it, and no caller does. Revision
  updates today happen only by re-issuing discovery.
- An open-vocabulary extension point for registering additional kinds and
  capabilities beyond the built-in set exists as a deferred mechanism; no
  caller currently registers anything beyond the built-in kinds and
  capabilities.
- The Resource→WorkItem relation kind is declared for typing purposes, but
  the correlation record itself is realized entirely through the
  `resources.work-correlation-*` event trio and its read models, not through
  a separately materialized generic relation record.
- Resources does not enforce that a correlated `WorkItemId` exists; a
  correlation may be recorded, and later retracted, against a `WorkItemId`
  Resources has no other knowledge of.
