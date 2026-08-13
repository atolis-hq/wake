# WorkItem — Component Specification

## Type, purpose, and scope

Aggregate. WorkItem is the stream-owning aggregate for a single unit of work
identified by a `WorkItemId`. It is the sole authority on whether a command
against that identity is accepted, and it is the source of every `work.*`
fact recorded for that identity.

## Responsibilities and boundaries

WorkItem owns command acceptance/rejection, lifecycle transitions, objective
revision, relation recording, auto-approval consent, and the freeze and
delete flags for its own identity. It does not decide *when* a caller should
close, cancel, grant/revoke consent, freeze, or delete — it only enforces
whether the command it receives is currently valid. It does not validate the
existence or state of a relation's target WorkItem; a relation's `to`
identity is recorded as given.

## Core policies, invariants, and behaviours

**Identity and creation**

- A `WorkItemId` MUST already be Wake-minted (matches Wake's own identity
  format) before a creation command is accepted. WorkItem does not mint
  identity.
- Creating a `WorkItemId` that does not yet exist MUST establish it as
  `open`, with the given objective and tags (tags default to an empty set).
- Creating a `WorkItemId` that already exists and is `open` MUST be accepted
  as a no-op: it MUST return the current view and MUST NOT record a second
  creation fact for that identity.
- Creating a `WorkItemId` that already exists and is `closed` or `cancelled`
  MUST be rejected.
- Creating a `WorkItemId` that already exists and is deleted MUST be
  rejected, the same as any other command against a deleted identity.
- The objective MUST be non-empty for both creation and revision.

**Existence and lifecycle gating**

- Any command other than creation, targeting a `WorkItemId` that does not
  exist, MUST be rejected.
- `closed` and `cancelled` are final: once a WorkItem reaches either, it MUST
  reject every subsequent command that would change its objective, relations,
  or lifecycle, including revision, linking (as the relation's source),
  closing, and cancelling. There is no command that transitions a WorkItem
  out of `closed` or `cancelled`.
- Recording a relation validates only the source WorkItem's own existence and
  open state; it does not require the target WorkItem to exist.

**Auto-approval consent**

- Setting auto-approval to the value it already holds MUST be accepted as a
  no-op regardless of lifecycle state, and MUST NOT record a new fact.
- Setting auto-approval to a new value is a state-changing command and is
  therefore rejected unless the WorkItem is `open`.

**Freeze**

- Setting frozen to the value it already holds MUST be accepted as a no-op
  regardless of lifecycle state, and MUST NOT record a new fact — the same
  pattern as auto-approval.
- Setting frozen to a new value is a state-changing command and is therefore
  rejected unless the WorkItem is `open`.
- Deletion clears frozen: a deleted WorkItem is never reported as frozen,
  regardless of its frozen state immediately before deletion.

**Deletion**

- Deletion MUST be accepted for a WorkItem in any lifecycle state — `open`,
  `closed`, or `cancelled` alike. Unlike every other state-changing command,
  it is not gated on the WorkItem being `open`, because deletion is a purge
  escape hatch rather than a lifecycle transition.
- Deleting an already-deleted WorkItem MUST be accepted as a no-op and MUST
  NOT record a new fact.
- Once deleted, a WorkItem MUST reject every subsequent command that would
  record a new fact against it, including creation, revision, linking,
  closing, cancelling, auto-approval changes, and freeze/unfreeze — even one
  that would otherwise be valid for the WorkItem's lifecycle state. Deletion
  is independent of and more final than `closed` or `cancelled`.

**Duplicate relations**

- Recording the same `(to, relation)` pair against a WorkItem more than once
  MUST NOT duplicate it in that WorkItem's related-items view. Each distinct
  `(to, relation)` pair appears at most once.

**Command identity**

- Replaying the exact same command MUST NOT change observable state or
  record an additional fact: a command's acceptance is idempotent by the
  command's own identity, independent of the WorkItem-level idempotency
  rules above.

## Event catalogue

| Event | Recorded when | Meaning |
| --- | --- | --- |
| `work.item-created` | A creation command is accepted for a not-yet-existing identity | This `WorkItemId` now denotes a real, `open` unit of work with the stated objective and tags. |
| `work.objective-revised` | A revision command is accepted | The WorkItem's objective is now the new value; the prior objective is no longer current. |
| `work.item-linked` | A link command is accepted | A directed relation now exists from this WorkItem to the named target. |
| `work.item-closed` | A close command is accepted | This WorkItem has reached its final, successful lifecycle state, for the stated reason. |
| `work.item-cancelled` | A cancel command is accepted | This WorkItem has reached its final, abandoned lifecycle state, for the stated reason. |
| `work.auto-approval-granted` | A grant command changes consent from withheld to granted | This WorkItem's future eligible acceptance decisions may now proceed automatically. |
| `work.auto-approval-revoked` | A revoke command changes consent from granted to withheld | This WorkItem's future acceptance decisions now require a human again. |
| `work.item-frozen` | A freeze command changes frozen from `false` to `true` | This WorkItem is now paused; its lifecycle state is unchanged. |
| `work.item-unfrozen` | An unfreeze command changes frozen from `true` to `false` | This WorkItem is no longer paused. |
| `work.item-deleted` | A delete command is accepted for a not-yet-deleted identity | This WorkItem's identity is now permanently purged; no further command against it will be accepted. |

## Conceptual schema

WorkItem state is the fold of its own `work.*` facts, keyed by `workItemId`.

| Field | Type | Description |
| --- | --- | --- |
| `workItemId` | Wake-minted identity | The stream's identity; every fact in the stream MUST belong to it. |
| `objective` | string, non-empty | Set by the first fact; replaced wholesale by each accepted revision. |
| `tags` | list of string | Set by the first fact; not revisable after creation. |
| `state` | closed vocabulary: `open` / `closed` / `cancelled` | Starts `open` on creation; moves to `closed` or `cancelled` and then never changes again. |
| `autoApprovalGranted` | boolean | Starts `false` on creation; flips on each accepted grant/revoke. |
| `frozen` | boolean | Starts `false` on creation; flips on each accepted freeze/unfreeze; forced back to `false` on deletion. |
| `deleted` | boolean | Starts `false` on creation; becomes `true` on an accepted delete and then never changes again. |
| `relatedWorkItems` | list of `Related WorkItem entry` | Starts empty; gains one entry per distinct `(workItemId, relation)` pair accepted (see below). |

**Related WorkItem entry** (child entity)

| Field | Type | Description |
| --- | --- | --- |
| `workItemId` | WorkItem identity | The related WorkItem's identity, as given; WorkItem does not verify it exists. |
| `relation` | closed vocabulary: `relates-to` / `parent-of` / `child-of` | How the owning WorkItem relates to the target. |

## Dependencies and system role

- Kernel — event/stream conventions for reading and appending its own
  single-identity stream; WorkItem's only dependency.
- Work projection (depends on WorkItem) — folds the same `work.*` facts into
  the module's cross-item read model; WorkItem does not depend back on it.
- Work application boundary (depends on WorkItem) — the only caller that
  loads, decides against, and appends to a WorkItem stream; no other module
  reads or writes `work.*` facts directly.

## Decisions, exclusions, and deferred capability

- There is no reopen command. A closed or cancelled WorkItem's identity is
  permanently final; a new need is expressed as a new WorkItem.
- There is no restore command. A deleted WorkItem's identity is permanently
  final and, unlike closing or cancelling, cannot even be recreated by a
  later creation command against the same identity.
- WorkItem does not validate relation graph consistency (e.g. it does not
  reject a `child-of` cycle, or require a reciprocal relation on the target).
- WorkItem does not retain prior objectives as queryable history; the event
  log is the only historical record.
