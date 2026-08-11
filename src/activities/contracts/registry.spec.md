# Activity Registry — Component Specification

## Type, purpose, and scope

Surface application. The Activity Registry is the module's single execution
surface: every concrete Activity registers into it once, and Execution
invokes exactly this registry — never a handler directly — to describe,
validate, and run an activation.

## Ubiquitous language

- **Registration** — the one-time act of adding an Activity Definition to
  the registry under its name.
- **Descriptor** — the registry's own read-only summary of a registered
  Activity (name, declared outcome kinds, resource requirements, execution
  kind), used by callers that need to know what an Activity is without
  running it.

## Responsibilities and boundaries

The Registry owns name uniqueness and outcome-kind uniqueness at
registration time, input validation before a handler executes, outcome
validation (declared-kind membership plus schema) after a handler executes,
and the read-only `describe`/`list` surface.

It does not own what a handler does when it executes — that is the concrete
Activity's own logic (Agent Activity, PR Decision, and any future Activity).
It does not prepare the `ActivityExecutionContext` a handler receives
(Execution's responsibility), and it does not decide which Activity a
workflow step should invoke (Orchestration's responsibility).

## Core policies, invariants, and behaviours

- Registering a name that is already registered MUST be rejected; an
  Activity registers at most once for the registry's lifetime.
- An Activity name MUST match the closed identifier format (lowercase,
  optionally dot/hyphen-segmented) or registration MUST be rejected.
- An Activity's declared `outcomeKinds` MUST NOT contain a duplicate value,
  or registration MUST be rejected.
- `describe`, `validateInput`, `validateOutcome`, and `execute` against an
  unregistered name MUST be rejected.
- Before a handler executes, the invocation's `input` MUST validate against
  the Activity's declared input schema; invalid input MUST be rejected
  without invoking the handler.
- After a handler returns, the outcome's `kind` MUST be a member of the
  Activity's declared `outcomeKinds`; an undeclared kind MUST be rejected
  even when the outcome value otherwise matches the Activity's outcome
  schema.
- The outcome MUST also validate against the Activity's declared outcome
  schema; a schema-invalid outcome MUST be rejected.
- `validateInput` and `validateOutcome` apply the same validation `execute`
  applies, so a caller can validate a value without invoking a handler or
  supplying an execution context.
- A registered Activity's descriptor (`outcomeKinds`, `resources`) is
  immutable once registered.

## Conceptual schema

**Activity Definition** (registration input; not durable, not returned by
any query)

| Field | Type | Description |
| --- | --- | --- |
| `name` | Activity name | The identifier this Activity registers under. |
| `inputSchema` | schema | Validates invocation input before the handler runs. |
| `outcomeSchema` | schema | Validates the handler's returned outcome. |
| `outcomeKinds` | list of closed-vocabulary outcome kind | The complete declared set of outcome kinds this Activity may return; MUST be duplicate-free. |
| `resources` | list of ResourceRequirement | What Execution must resolve before invoking this Activity. |
| `executionKind` | closed vocabulary: `agent` / `script` / `deterministic` | How Execution should treat running this Activity. |
| `handler` | Activity Handler | The logic that executes an invocation and returns an outcome. |

**Activity Descriptor** (the registry's own read-only view of a
registration)

| Field | Type | Description |
| --- | --- | --- |
| `name` | Activity name | The registered identifier. |
| `outcomeKinds` | list of closed-vocabulary outcome kind | Frozen copy of the definition's declared kinds. |
| `resources` | list of ResourceRequirement | Frozen copy of the definition's declared requirements. |
| `executionKind` | closed vocabulary: `agent` / `script` / `deterministic` | Frozen copy of the definition's declared execution kind. |

## Dependencies and system role

- Kernel — closed-vocabulary and branded-identifier conventions Activity
  names and outcome kinds are built from.
- Resources (Registry depends on it) — a `ResourceRequirement`'s
  `capability` names a capability Resources defines; the Registry does not
  itself resolve resources.
- Agent Activity, PR Approve & Merge Decision (depend on the Registry) —
  every concrete built-in Activity registers into exactly this registry at
  composition time.
- Execution (depends on the Registry) — the only caller of `execute`,
  `describe`, and `validateInput`/`validateOutcome`; it resolves and
  supplies the `ActivityExecutionContext` a handler receives.
- Orchestration (depends on the Registry, via composition) — compiles a
  workflow's steps against the set of registered Activities to validate a
  workflow definition references real Activities and outcome kinds.

## Decisions, exclusions, and deferred capability

- Registration is in-memory and per-process; there is no durable registry
  state to rebuild — the set of registered Activities is re-established each
  time the composition root runs.
- The Registry enforces outcome-kind membership defensively even though a
  well-behaved handler already returns only its own declared kinds; this is
  meant to catch a handler/definition drift, not a normal-path outcome.
