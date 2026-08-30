---
asOf: b3907794
---

# Bootstrap - Module Specification

## Purpose and scope

Bootstrap loads root configuration, selects concrete adapters, composes the
application graph, and exposes process and surface applications. It is the
only module that knows the complete graph.

## Responsibilities and boundaries

Bootstrap owns paths, configuration validation, adapter selection, projection
composition, provider composition, process hosts, and the Eventing runtime
registry. It does not own domain policy, provider payload contracts,
Persistence semantics, or processor handlers.

## Runtime composition

The composition root creates one `EventProcessorRuntime` with the journal,
checkpoints, and injected Persistence serialiser. It registers every resident
processor exactly once: projections, activation scheduling, orchestration
reactions, artifact registration, delivery outcomes, agent publication, and
provider inbound translation. The runtime starts one Eventing host over that
explicit registry and provides unified health and lag reporting.

The runtime's one-shot catch-up and through-position barriers are explicit
freshness boundaries. Projection rebuilds use the same consumer serialiser as
live processing. Bootstrap does not create a second host or legacy
subscription configuration.

## Pipeline and reconciliation lanes

The intake pipeline polls providers and translates inbound evidence; it is the
only rate-limited external polling lane and backs off when idle. The runner
pipeline performs schedule evaluation, reactions, publication, delivery, and
explicit projection catch-up. One-shot ticks run the configured pipelines and
poke the activation-scheduler processor at the documented boundary.

Watch, resource-transition, provider, and delivery reconciliation remain
separate bounded recovery lanes. Schedule and provider poll watermarks are
operational state, not processor cursors. Surface health and event diagnostics
read the runtime without mutating facts.

## Health and failure

Eventing reports per-processor starting, catching-up, healthy, degraded, and
stopped state with checkpoint and lag. A failed processor retries independently
and does not stop siblings. Bootstrap overlays startup and fallback
reconciliation diagnostics until a successful pass clears them.

## Public composition contract

`index.ts` is the only public entry. Bounded modules define typed processors
and handlers through their public contracts. They cannot construct
`EventProcessorHost` or concrete processor serialisers. Persistence supplies
storage and keyed serialisation only; Bootstrap alone composes the complete
registry.

## Configuration and scenarios

Root sections are `work`, `resources`, `activities`, `orchestration`,
`execution`, `controlPlane`, `integrations`, `surfaces`, `transcripts`, and
`host`. Runtime paths are resolved below `.wake/`, with workspaces below
`workspaces/`.

E2E-CONFIG-001, E2E-OPS-INIT-001, E2E-OPS-001.
