# src — Specification Index

This is the entry point into every target behavioural specification under
`src/`. Start at [SPECIFICATION.md](SPECIFICATION.md) for the standard
these documents follow, then use the table below to reach any module's
`SPEC.md`. Each module page links on to its own component `.spec.md` files —
this index does not link across modules or duplicate that detail.

## Standard event architecture

A bounded module owns its event types, payload map, stream references,
selector/decoder, and `create<Owner>EventData` factory. It creates immutable
`EventData` with no stream or journal metadata. `EventJournal.appendToStream`
records a non-empty expected-sequence batch as `EventEnvelope<EventData>`,
adding the stream, recording time, sequence, and global position. Modules own
their conflict and idempotency decisions; the `@atolis-hq/eventing` workspace
package hosts subscriptions, checkpoints, and projections without domain
knowledge; `@atolis-hq/eventing-filesystem` records and loads envelopes; and
Bootstrap composes both.

| Module | Purpose |
| --- | --- |
| [kernel](kernel/SPEC.md) | Stable universal primitives every other module builds on. |
| `@atolis-hq/eventing` | Persistence-neutral event contracts, ports, processor runtime, and in-memory adapters. |
| `@atolis-hq/eventing-filesystem` | Node filesystem implementations of Eventing ports. |
| [work](work/SPEC.md) | Durable WorkItem identity and lifecycle. |
| [resources](resources/SPEC.md) | Canonical Resource identity, capabilities, and correlation to Work. |
| [conversations](conversations/MODULE.md) | Canonical provider-neutral WorkItem discussion facts and projections. |
| [activities](activities/SPEC.md) | The Activity contract and built-in specialist SDLC capabilities (agent execution, PR approve/merge). |
| [orchestration](orchestration/SPEC.md) | Configured workflow interpretation and durable workflow instances. |
| [execution](execution/SPEC.md) | Runs, dispatch, runners, workspaces, supervision, and recovery. |
| [integrations](integrations/SPEC.md) | Provider adapters, inbound translation, delivery, and reconciliation. |
| [control-plane](control-plane/SPEC.md) | System-level bounded coordination through `advanceOnce`. |
| [bootstrap](bootstrap/SPEC.md) | Configuration loading, dependency composition, and process startup. |
| [surfaces](surfaces/SPEC.md) | CLI, API, and UI presentation over public applications and views. |
