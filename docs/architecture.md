# Wake Architecture

## Principles

- Wake is a control plane, not a long-lived worker session.
- Durable state files are schema-validated state-of-record.
- Immutable event envelopes are the primary durable record.
- Canonical deterministic fields stay separate from extensible agent-readable context.
- Structured event audits drive automation and diagnostics.
- Fake adapters are permanent test harnesses and future real-adapter seams.
- Real runner integrations live behind the same adapter boundary, with Claude Haiku smoke tests kept intentionally minimal.

## Module Boundaries

- `src/domain`: pure types, schemas, sentinels, and comment-marker rules
- `src/core`: lifecycle orchestration, tick policy, and resident loop control
- `src/adapters`: filesystem IO, fake integrations, and real runner adapters
- `src/lib`: focused utilities for paths, files, locks, and event shaping

## Durable State

Wake owns a central `.wake/` home. The canonical durable record is an append-only
event stream; projections and summaries are derived from it:

- `config.json` for versioned config
- `ledger.json` for pause windows and future budget state
- `events/<date>.jsonl` for immutable imported and internal event envelopes
- `state/<repo>/<issue>.json` for a derived projection of the current work item
- `runs/<run-id>.json` for per-invocation records
- optional future prompt/context artifacts derived from events plus projections

The projection file is no longer the source of truth. It is a materialized view
used for fast deterministic routing. If projection logic changes, Wake should be
able to rebuild `state/` from the canonical event stream.

Each event envelope should carry:

- a stable event id and schema version
- source system and source event type such as `github.issue_comment.created`
- correlation identifiers for the work item, issue, comment, review, or PR
- `occurredAt` and `ingestedAt`
- a normalized canonical payload Wake scripts can rely on
- optional source-specific raw payload fragments
- optional derived hints computed cheaply during ingestion

This lets the same durable artifacts serve three roles:

- trigger Wake when relevant external or internal changes arrive
- provide agent context for continuing work
- provide a replayable audit trail

Per-issue projection files should deliberately separate canonical deterministic
fields from optional `context` payloads that can grow for agent-facing data later
without destabilizing scripts.

## Event-First Flow

The intended flow is:

1. ingest a source event from GitHub, Jira, or another system
2. write an immutable event envelope
3. update one or more projections such as `state/<repo>/<issue>.json`
4. let deterministic policy read projections and selected event slices
5. let the runner prompt receive a compact projection summary plus relevant
   recent events, with direct event-file reading available when needed

Wake should not require the model to scan a full raw event stream by default.
The control plane should pick the relevant slice and keep prompts cheap.

## Runner Strategy

The repo supports two runner modes:

- `fake`: deterministic tests and local tick development without token spend
- `claude`: a real Claude Code adapter with JSON-print mode for smoke tests and a remote-control smoke path

The minimal smoke prompt is:

```text
This is Eddy, reply with "hi Eddy only"
```

That keeps token usage low while proving the CLI, session capture, and remote-control surfaces are wired correctly.
