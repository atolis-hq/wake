# Global Dispatch Pause and Resume — Component Specification

## Type, purpose, and scope

Policy/process. The only composed command path to a manually-caused global
dispatch pause or resume, and the `isPaused` read that Advancement's
`isDispatchPaused` gate calls before every attempt at recovery,
reconciliation, or selection.

## Ubiquitous language

- **Global dispatch pause command** — the operator-initiated `pause`/
  `resume` command handled by this component, always recorded as an
  indefinite pause (no `resumeAt` deadline an operator set explicitly; see
  Decisions).

## Responsibilities and boundaries

This component owns accepting a `pause`/`resume` command, appending the
resulting `DispatchPaused`/`DispatchResumed` fact when the command is not a
no-op, and per-`idempotencyKey` duplicate suppression for that acceptance. It
also owns `isPaused`, the read Advancement's `isDispatchPaused` supplier
calls. It does not decide whether pausing is warranted, does not implement
the quota-driven, count-based dispatch pause Dispatch Policy computes (that
path is not composed by anything today), and does not read or write through
the Control Plane view projection — `isPaused` and the no-op guard inside
`pause`/`resume` each independently fold the same `control-plane:global`
stream's `DispatchPaused`/`DispatchResumed` events themselves.

## Core policies, invariants, and behaviours

- `isPaused` MUST fold every `DispatchPaused`/`DispatchResumed` event on the
  `control-plane:global` stream in append order, ending paused if the last
  such event is `DispatchPaused` and resumed if the last is `DispatchResumed`
  (or if neither has ever occurred).
- `pause`/`resume` MUST derive a correlation id deterministically from the
  operation name and the caller-supplied `idempotencyKey`. Replaying the same
  `(operation, idempotencyKey)` pair MUST NOT append a second event: if an
  event of the matching type and correlation id already exists on the
  stream, the call MUST return without reading or writing anything further.
  This idempotency is durable (backed by the journal itself), unlike Runner
  Pause and Resume's in-memory-only idempotency.
- Beyond the idempotency-key check, `pause` MUST also no-op (append nothing)
  when `isPaused` already reports `true`, and `resume` MUST no-op when
  `isPaused` already reports `false` — a redundant pause/resume command
  never produces a redundant event even under a fresh `idempotencyKey`.
- A `pause` command MUST append `DispatchPaused` with a fixed `reason` of
  `'paused by operator'` and a `resumeAt` set to a fixed far-future sentinel
  timestamp (`9999-12-31T23:59:59.999Z`) — this component records only
  indefinite, manually-resumed pauses; it never derives a bounded deadline.
- A `resume` command MUST append `DispatchResumed` with `resumedAt` set to
  the command's own `occurredAt`.
- Every appended event's `actor` MUST be recorded as `EventActorKind.Operator`
  with id `'web'`, and MUST reuse one `commandId`/`correlationId`/
  `occurredAt` context for the single event appended by that call.

## Conceptual schema

**Global dispatch pause/resume command** (per call; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `idempotencyKey` | string | Caller-supplied key this component's durable dedupe is keyed on, together with the operation name (`pause` or `resume`). |

## Dependencies and system role

- Kernel — event journal read/append on the global stream, Clock,
  IdGenerator, and `correlationId` derivation.
- Control Plane view (related, not depended on) — folds the same
  `DispatchPaused`/`DispatchResumed` events this component appends, for
  status display; this component does not read that projection itself.
- Advancement (dependent) — in production composition, this component's
  `isPaused` is Advancement's injected `isDispatchPaused` supplier.
- Bootstrap's API pause/resume command surface (depends on this component) —
  the only caller of `pause`/`resume`.

## Decisions, exclusions, and deferred capability

- Only a manual, indefinite pause is implemented here. Dispatch Policy's
  count-based, quota-driven pause/resume decision logic exists as pure logic
  elsewhere in this module but is not composed into any path that appends
  `DispatchPaused`/`DispatchResumed` — this component is currently the only
  composed appender of either event.
- `isPaused` and the Control Plane view projection both fold the same two
  event types independently rather than one reading the other; they agree by
  construction (same source events, same fold semantics) but are two
  separate implementations, not a single shared one.
