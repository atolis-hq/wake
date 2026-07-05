# Wake Architecture

## Principles

- Wake is a control plane, not a long-lived worker session.
- Durable state files are schema-validated state-of-record.
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

Wake owns a central `.wake/` home that acts as the state-of-record:

- `config.json` for versioned config
- `ledger.json` for pause windows and future budget state
- `state/<repo>/<issue>.json` for canonical issue/comment snapshots plus Wake state
- `runs/<run-id>.json` for per-invocation records
- `events/<date>.jsonl` for append-only audit events

Per-issue files deliberately separate canonical deterministic fields from optional `context` payloads that can grow for agent-facing data later without destabilizing scripts.

## Runner Strategy

The repo supports two runner modes:

- `fake`: deterministic tests and local tick development without token spend
- `claude`: a real Claude Code adapter with JSON-print mode for smoke tests and a remote-control smoke path

The minimal smoke prompt is:

```text
This is Eddy, reply with "hi Eddy only"
```

That keeps token usage low while proving the CLI, session capture, and remote-control surfaces are wired correctly.
