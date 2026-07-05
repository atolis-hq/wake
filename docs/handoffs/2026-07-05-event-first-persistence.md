# Event-First Persistence Handoff

## Purpose

Wake's current skeleton persists:

- per-issue projection files in `state/`
- append-only audit events in `events/`
- per-run records in `runs/`

That works, but it leaves the projection too close to source-of-truth. The next
refactor should make **event envelopes** the primary durable record and treat
`state/` as a derived materialized view.

## Target model

Wake should persist three distinct layers:

1. **Canonical event stream**
   - immutable envelopes under `.wake/events/<date>.jsonl`
   - imported external events and internal Wake decisions
2. **Derived projections**
   - current work-item views under `.wake/state/<repo>/<issue>.json`
   - optimized for deterministic policy decisions and resume routing
3. **Execution records**
   - per-run records under `.wake/runs/<run-id>.json`
   - attempts, outcomes, costs, sentinels, session ids

The projection is rebuildable. The event stream is the durable truth.

## Event envelope shape

Each event envelope should include:

- `eventId`
- `schemaVersion`
- `sourceSystem`
  - example: `github`, `jira`, `wake`
- `sourceEventType`
  - example: `github.issue.created`, `github.issue.comment.created`,
    `github.pull_request.review.submitted`, `wake.run.completed`
- `workItemKey`
  - Wake's stable correlation key for the item under management
- `sourceRefs`
  - repo, issue number, PR number, comment id, review id, source URL
- `occurredAt`
- `ingestedAt`
- `trigger`
  - whether this event should wake policy evaluation immediately or just enrich
    context
- `payload`
  - normalized canonical fields deterministic scripts can rely on
- `raw`
  - optional source-specific subset preserved for later context
- `derivedHints`
  - optional cheap ingestion-time hints such as `wakeAuthoredComment=false`

## Projection shape

The per-issue projection should remain cheap to read and deterministic. It
should summarize:

- current stage
- attempts
- current session refs
- workspace refs
- last seen issue metadata
- last seen comment/review metadata
- recent important event ids
- optional `context` for agent-readable supplements

Projection files should not duplicate the full imported history beyond what is
needed for current-state routing.

## Ingestion and routing flow

The intended control-plane flow is:

1. poll or receive source-system changes
2. normalize and persist event envelopes first
3. update affected projections from those envelopes
4. choose the next deterministic action from projections plus gate state
5. assemble prompt context from:
   - projection summary
   - selected recent event envelopes
   - prior session id or run references
6. persist new internal events and run records

This keeps the tick a pure function of durable inputs while avoiding wasteful
prompt assembly from a full raw stream.

## Prompt strategy

Do not make the default runner path dump the whole event stream into the model.

Preferred order:

1. projection summary
2. curated recent event slice
3. direct event-file reading only when needed

This preserves the event-first durable model without turning every run into a
token-heavy replay.

## Concrete next implementation steps

1. Add a first-class event-envelope schema in `src/domain/`.
2. Split current `event` audit records into:
   - imported source events
   - Wake internal control-plane events
3. Refactor fake GitHub sync to emit canonical issue/comment events first.
4. Build a projection updater that consumes envelopes and writes `state/`.
5. Change tick orchestration to read from projections, not directly from raw
   fake issue snapshots.
6. Update prompt assembly to pass a projection summary plus selected recent
   envelopes.
7. Keep the Claude Haiku smoke path minimal and separate from the richer runner
   prompt path.

## What can stay

- the TypeScript app structure
- the runner adapter boundary
- the fake runner
- the real Claude smoke runner
- the lock/tick/control-plane structure
- the existing `runs/` model as a separate execution record layer

## What should change first

- stop treating fake issue snapshots as the primary durable input
- make event ingestion explicit in the adapter boundary
- make `state/` a projection in code and docs, not just in intention

## Session prompt seed

The next session should start by reading:

- `docs/architecture.md`
- `docs/implementation.md`
- `docs/handoffs/2026-07-05-event-first-persistence.md`

Then it should refactor the durable-state model so event envelopes are primary
and `state/` becomes a derived projection.
