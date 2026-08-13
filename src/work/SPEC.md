---
asOf: 31cb84460b6099ea50edc17a70d3ec679ba08cc5
---

# Work — Module Specification

## Purpose and scope

Work owns the durable identity and lifecycle of a WorkItem: the thing Wake is
doing, independent of how it is being executed. Every other module that
correlates activity to "a piece of work" — an observed external resource, a
workflow instance, a Run — anchors to a WorkItem identity that Work owns.

## Responsibilities and boundaries

Work owns:

- WorkItem identity, objective, tags, lifecycle state, and inter-WorkItem
  relations.
- Operator consent for automatic acceptance authority (auto-approval), as a
  durable fact separate from lifecycle.
- Operator-set freeze and permanent-delete flags, as durable facts separate
  from lifecycle state.
- Acceptance and rejection of commands that change a WorkItem.

Work does not own:

- Deciding what work to start, how to route it to a workflow, or which
  Activities to run. That is Orchestration's responsibility.
- Correlating a WorkItem to an external provider resource. That is
  Resources' responsibility; Work only receives an already-minted
  `WorkItemId`.
- Minting the `WorkItemId` value itself. Identity is minted once, upstream of
  Work, at the point an external observation is first admitted as Wake work;
  Work only accepts and validates that a `WorkItemId` follows Wake's own
  format. Work never derives identity from a provider key.

## Ubiquitous language

- **WorkItem** — an identity-bearing unit of work with an objective, a
  lifecycle state, tags, and relations to other WorkItems.
- **Objective** — the current, revisable statement of what the WorkItem is
  for.
- **Lifecycle state** — `open`, `closed`, or `cancelled`. This is a
  fact about the WorkItem itself, not about workflow progress; a WorkItem
  can be `open` while its workflow is anywhere in its own process.
- **Auto-approval** — an operator-granted consent that a WorkItem's future
  acceptance decisions may be taken automatically. Work records only the
  consent; which decisions are eligible to use it is decided elsewhere.
- **Frozen** — an operator-set durable flag that pauses further automatic
  progress on an `open` WorkItem without ending its lifecycle. Work records
  only the flag; what freezing suppresses is decided elsewhere.
- **Deleted** — a permanent purge flag, independent of lifecycle state, that
  once set blocks every further command against the WorkItem's identity.
- **Relation** — a directed, named connection from one WorkItem to another
  (`relates-to`, `parent-of`, `child-of`).

## Core policies, invariants, and behaviours

- A WorkItem MUST exist (have at least one accepted `ItemCreated` fact)
  before any other command against it is accepted.
- A command that would create a WorkItem whose identity already exists and is
  `open` MUST be accepted without changing observable state (see
  `work-item.spec.md` for exact idempotency semantics).
- Once a WorkItem is `closed` or `cancelled`, it MUST NOT accept any further
  command that changes its state. Lifecycle is a one-way exit: there is no
  command to reopen a closed or cancelled WorkItem.
- Setting auto-approval to the value it already holds MUST be accepted as a
  no-op regardless of lifecycle state. Setting it to a new value is a
  state-changing command and is therefore subject to the same open-only rule
  as any other.
- Setting frozen to the value it already holds MUST be accepted as a no-op
  regardless of lifecycle state, exactly like auto-approval. Setting it to a
  new value is a state-changing command and is therefore subject to the same
  open-only rule as any other.
- Deletion MUST be accepted for a WorkItem in any lifecycle state — `open`,
  `closed`, or `cancelled` alike — unlike every other command. Deleting an
  already-deleted WorkItem MUST be accepted as a no-op. Deletion also clears
  the frozen flag.
- Once deleted, a WorkItem MUST reject every further command against its
  identity, including a repeated creation command and freeze/unfreeze;
  deletion is more final than `closed` or `cancelled` because it exists
  independently of lifecycle state.
- A relation between two WorkItems MUST be idempotent: recording the same
  `(to, relation)` pair against a WorkItem more than once MUST NOT duplicate
  it in that WorkItem's related-items view.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `work.item-created` | A WorkItem is first admitted | A new unit of work now exists under a Wake-minted identity, with its initial objective and tags. |
| `work.objective-revised` | The objective changes | What the WorkItem is for has changed; prior objectives are not retained as separate facts. |
| `work.item-linked` | A relation is recorded from one WorkItem to another | The two WorkItems are now known to relate in the stated way. |
| `work.item-closed` | The WorkItem reaches a successful, final lifecycle state | The unit of work is done; no further state-changing command applies. |
| `work.item-cancelled` | The WorkItem reaches an abandoned, final lifecycle state | The unit of work was abandoned before completion; no further state-changing command applies. |
| `work.auto-approval-granted` | An operator consents to automatic acceptance for this WorkItem | Future eligible acceptance decisions for this WorkItem may proceed without a human in the loop. |
| `work.auto-approval-revoked` | An operator withdraws that consent | Future acceptance decisions for this WorkItem require a human again. |
| `work.item-frozen` | An operator freezes an `open` WorkItem | Further automatic progress on this WorkItem should pause; the lifecycle itself is unchanged. |
| `work.item-unfrozen` | An operator lifts a freeze | This WorkItem is no longer paused. |
| `work.item-deleted` | An operator permanently purges the WorkItem | This WorkItem's identity is retired; no further command against it will be accepted. |

## Conceptual schema

**WorkItem**

| Field | Type | Description |
| --- | --- | --- |
| `workItemId` | Wake-minted identity | Never derived from a provider key. |
| `objective` | string, non-empty | Current statement of what the WorkItem is for. |
| `tags` | list of string | Operator-assigned classification labels; empty by default. |
| `state` | closed vocabulary: `open` / `closed` / `cancelled` | Lifecycle state; only `open` accepts further state-changing commands. |
| `autoApprovalGranted` | boolean | Whether operator consent for automatic acceptance is currently in force. |
| `frozen` | boolean | Whether the WorkItem is currently paused; always `false` once `deleted` is `true`. |
| `deleted` | boolean | Whether the WorkItem has been permanently purged; once `true`, no further command is accepted. |
| `relatedWorkItems` | list of `Related WorkItem entry` | The WorkItem's related-item entries (see below). |

**Related WorkItem entry** (child entity of WorkItem)

| Field | Type | Description |
| --- | --- | --- |
| `workItemId` | WorkItem identity | Identity of the related WorkItem; Work does not require it to exist. |
| `relation` | closed vocabulary: `relates-to` / `parent-of` / `child-of` | How the owning WorkItem relates to the target. |

## Child components and interactions

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [WorkItem](domain/work-item.spec.md) | aggregate | Identity, lifecycle, objective, tags, relations, auto-approval consent; command acceptance/rejection | Produces the `work.*` facts that the Work projection folds and that other modules correlate against. |
| Work projection | projection | The current `WorkItemView` read model per WorkItem | Rebuilds purely from `work.*` facts; callers (the surface application, other modules' policies) read it rather than folding events themselves. |
| Work application boundary | surface application | Validating and routing create/revise/link/close/cancel/grant/revoke commands to the aggregate, and exposing the current view | The only path by which a command reaches the WorkItem aggregate; never applies a command directly to stored events. |

## Dependencies and system role

- Kernel — event journal, envelope, and command context conventions; Work's
  only dependency, and the only thing it needs to append and rehydrate its
  own streams.
- Resources (depends on Work) — correlates an observed external resource to
  a `WorkItemId` it did not mint, anchoring provider-side identity to Wake
  identity.
- Orchestration (depends on Work) — reads a WorkItem's identity and
  auto-approval consent to decide workflow acceptance behaviour; changes
  Work state only through Work's own commands.
- Control-plane (depends on Work) — cascades a Work cancellation into
  blocking the workflows and Runs correlated to that WorkItem, by calling
  Work's `cancel` command rather than writing `work.*` facts itself; also
  reads a WorkItem's `frozen` and `deleted` facts to exclude it from
  workflow activation advancement.

## Decisions, exclusions, and deferred capability

- There is no command to reopen a `closed` or `cancelled` WorkItem. A new
  need is a new WorkItem.
- There is no command to restore a deleted WorkItem. Deletion is permanent
  and, unlike closing or cancelling, also blocks recreation of the same
  identity.
- Work does not version or retain objective history; only the current
  objective is a durable fact of the read model. The event log itself
  remains the historical record.
- Relation kinds are limited to `relates-to`, `parent-of`, and `child-of`;
  Work does not enforce that these form a consistent graph (e.g. it does not
  reject a `child-of` cycle) — that is left as a deferred capability.
