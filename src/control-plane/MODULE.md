# control-plane

## Purpose

System-level bounded coordination through the activation scheduler and its
`advanceOnce` compatibility facade.

## Owns

Signals, eligibility, selection, budgets, dispatch coordination, schedule
policy, durable trigger requests/claims/pause/history, and host-facing pipeline contracts.

## Does not own

Work, workflow, execution, provider policy, processor hosting, or concrete
serialisation.

## Invariants

The activation scheduler is an Eventing processor definition owned by Control
Plane and composed by Bootstrap. Each delivered batch is a reconsideration;
the processor host owns cursor advancement, while the scheduler owns bounded
selection and durable effects. Its separate reconciler and schedule/poll
watermarks remain explicit one-shot or periodic lanes.

When more activations are ready than capacity allows, `DispatchPolicy` orders
candidates by fewer remaining agent steps, then watch-driven before normal
transitions, then retried before first runs, then `requestedPosition` and
`activationId`. Orchestration computes the priority; Control Plane only orders.
There is no starvation mitigation: a steady supply of near-complete or
watch-driven work can delay a long workflow indefinitely.
A candidate with no eligible runner still stops the dispatch pass; a paused
runner pool can therefore hold up lower-ranked work on other pools.

## Public contracts

`index.ts` is the only public entry.

## Configuration

Owns `controlPlane` dispatch limits, triggers, and resident-loop backoff.
Named trigger context scopes use Artifact's public scope-name validation;
Control Plane exports their single-flight coordination-key encoding.

## Relations and events

Owns `control-plane.` events and defines no domain relation semantics.

## Failure and recovery

Selection, caps, pauses, retries, and scheduler serialisation remain explicit
and bounded. Processor failure is surfaced through Eventing health; startup
and fallback reconciliation retain their own diagnostics.
Trigger pause suppresses automatic sources and clears only pending automatic reasons.
Manual requests survive pause and restart without resuming the trigger or resetting retries.
Mixed pending sources retain each manual command for admission checks and durable skipped outcomes.
Trigger claims and pause/resume commands share a durable home lock; recovery
completes committed claims with stable invocation identities. Cron watermarks
belong to processor state, while request and invocation facts remain
authoritative in the journal.
Operational projections are keyed by coordination scope and retain only the
active claim, last starts/requests, pause state, and at most 64 pending source
reasons. Invocation history has a separate document and stream per WorkItem.
Skipped background occurrences advance processor cursors without journal request facts.
Manual commands retain their initial disposition in durable request facts for
idempotent retries, including skips, without expanding operational projections.
Completed manual starts record the invocation WorkItem in a started request fact;
queued manual outcomes identify the active WorkItem holding the slot.
Their latest actual skip diagnostics are bounded processor-owned operational
state (256 recent trigger identities), exposed through service inspection with
source/time provenance; they are not projections or occurrence history.
Resident coordination folds new journal batches incrementally; history is read
only on explicit inspection. Blocked workflows retain their single-flight slot
because operator retry or clarification can reactivate them.

## Extension rules

Define processor selectors and handlers here when they are Control Plane
policy, but leave host construction, concrete adapters, and full registry
composition to Bootstrap.

## Scenarios

E2E-CONTROL-001, E2E-CONTROL-002, E2E-CONTROL-003, E2E-CONTROL-004.

The Triggers surface exposes operator standing instructions through each configured explicit contextScope. No scope is inferred for a trigger. Artifacts owns edits, revision concurrency, storage and read-only MCP semantics; Bootstrap binds trusted operator commands and captures revisions for execution.

Trigger inspection surfaces operator documents orphaned by removal or renaming of configured scopes. Reusing a named scope reconnects its existing document; inspection never invents or registers scopes.
