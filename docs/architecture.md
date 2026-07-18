# Wake Architecture

## Principles

- Wake is a control plane, not a long-lived worker session.
- Durable state files are schema-validated state-of-record.
- Immutable event envelopes are the primary durable record.
- Canonical deterministic fields stay separate from extensible agent-readable context.
- Structured event audits drive automation and diagnostics.
- Agent-produced outbound intents use the same event model as imported source events.
- Fake ticketing-system and runner adapters are permanent test harnesses and future real-adapter seams.
- Real runner integrations live behind the same adapter boundary, with Claude Haiku smoke tests kept intentionally minimal.
- Ticketing adapters must translate provider-specific payloads into canonical
  ticket events before core consumes them.

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
- `state/<workId>.json` for a derived projection of the current work item
- `state/index/<xx>.json` for the reverse index that resolves a resource to its work item
- `runs/<run-id>.json` for per-invocation records
- optional future prompt/context artifacts derived from events plus projections

The projection file is no longer the source of truth. It is a materialized view
used for fast deterministic routing. If projection logic changes, Wake should be
able to rebuild `state/` from the canonical event stream.

A work item's identity is a minted `work-<ulid>`, not the ticket that started it.
Sources do not assign it: they stamp `sourceRefs.resourceUri` (a
`<provider>:<kind>:<locator>` string, e.g. `github:issue:owner/repo#82`), and the
control plane resolves that through the reverse index to the owning work item,
minting a new one on a miss. This is why no durable path embeds a provider, repo,
or issue number — a ticket can be transferred or renumbered, and one work item may
have several representations. See
[ADR 0001](adrs/0001-correlating-external-resources-to-work-items.md) and the
[work identity and correlation design](superpowers/specs/2026-07-16-work-identity-correlation-design.md).

Each event envelope should carry:

- a stable event id and schema version
- source system and source event type such as `github.issue_comment.created`
- correlation identifiers for the work item, issue, comment, review, or PR
- `occurredAt` and `ingestedAt`
- a normalized canonical payload Wake scripts can rely on
- optional source-specific raw payload fragments
- optional derived hints computed cheaply during ingestion

Core modules should branch on canonical ticket events such as `ticket.upsert`,
`ticket.comment.created`, `ticket.comment.updated`, and
`ticket.reply.published`. Provider-specific event names such as GitHub issue
webhook or API concepts belong in `sourceSystem`, `sourceRefs`, and optional
`raw` fragments for diagnostics only.

This lets the same durable artifacts serve three roles:

- trigger Wake when relevant external or internal changes arrive
- provide agent context for continuing work
- provide a replayable audit trail

They should also support a fourth role:

- represent outbound agent intents that the control plane will publish to one or
  more configured channels

Per-issue projection files should deliberately separate canonical deterministic
fields from optional `context` payloads that can grow for agent-facing data later
without destabilizing scripts.

## Event-First Flow

The intended flow is:

1. ingest a source event from GitHub, Jira, or another system
2. resolve its `sourceRefs.resourceUri` to a work item through the reverse index,
   minting a new work item on a miss, and stamp the resulting `workItemKey`
3. write an immutable event envelope
4. update one or more projections such as `state/<workId>.json`
5. let deterministic policy read projections and selected event slices
6. let the runner prompt receive a compact projection summary plus relevant
   recent events, with direct event-file reading available when needed

Wake should not require the model to scan a full raw event stream by default.
The control plane should pick the relevant slice and keep prompts cheap.

## Inbound And Outbound Events

The event stream is not just an import log. Wake should use one canonical event
model for both:

- **inbound source events**
  - GitHub issue created
  - GitHub issue comment created
  - PR review submitted
  - Jira ticket updated
- **outbound Wake intents**
  - question publish requested
  - status update publish requested
  - handoff message publish requested
  - PR link publish requested

The agent should not need to know which delivery channel to integrate with.
Instead it can emit a Wake event or request an event through a Wake-owned
surface. The control plane then decides how to publish that event to GitHub,
Slack, or another configured sink.

This preserves channel independence:

- the agent expresses intent
- Wake owns routing and delivery policy
- sink-specific formatting lives in adapters, not agent prompts

## Global Intake And Work-Item Streams

Not every important event originates inside a single issue thread. Wake should
distinguish between:

- **global intake/index events**
  - all synced work signals across systems
  - used for scanning, prioritization, and pickup decisions
- **correlated work-item streams**
  - the subset of events linked to a chosen `workItemKey`
  - used as detailed execution context for a run

When a ticket or item is picked up, Wake should correlate the relevant intake
events into a work-item stream and build projections from that stream. That lets
the queue stay broad while each active run stays context-rich and focused.

## Runner Strategy

The repo supports two runner modes:

- `fake`: deterministic tests and local tick development without token spend
- `claude`: a real Claude Code adapter with JSON-print mode for smoke tests and a remote-control smoke path

The minimal smoke prompt is:

```text
This is Eddy, reply with "hi Eddy only"
```

That keeps token usage low while proving the CLI, session capture, and remote-control surfaces are wired correctly.
