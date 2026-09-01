---
asOf: 6e394e8258d688f3d98220d995cc0c38093b7745
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
Eventing filesystem semantics, or processor handlers.

Bootstrap is the only composition root: it wires module event-data factories,
Eventing filesystem adapters, Eventing subscriptions/checkpoints/projections, and the
complete processor registry. Composition activities may supply typed inputs to
and invoke an owning module's public event-data factory, but Bootstrap never
calls Kernel's `createEventData` or reproduces an owner's event mapping. The
owner factory constructs the event data, and Bootstrap does not bypass that
module's stream and expected-sequence append path.

When Bootstrap composes filesystem storage, it declares the delivery outcome
reactor's recovery consumer to `FileProjectionStore`. This reserves that
consumer's current, legacy, and collision-isolated compatible paths, so a
scoped or full projection clear cannot delete processor recovery state.

## Runtime composition

The composition root creates one `EventProcessorRuntime` with the journal,
checkpoints, and injected Eventing filesystem serialiser. It registers every resident
processor exactly once: provider translation, domain and integration reactors,
agent publication, projections, and activation scheduling. The runtime starts
one Eventing host over that explicit registry and provides unified health and
lag reporting. Bootstrap gives the delivery outcome reactor that same required
serialiser, so direct reconciliation and processor delivery cannot concurrently
change its persisted pending-confirmations recovery state.

The runtime's one-shot catch-up and through-position barriers are explicit
freshness boundaries. Projection rebuilds use the same consumer serialiser as
live processing. Bootstrap does not create a second host or legacy
subscription configuration.

## Pipeline and reconciliation lanes

The intake pipeline polls providers; it is the only rate-limited external
polling lane and backs off when idle. Eventing processors translate provider
evidence and run reactors and publication. The runner pipeline performs
schedule evaluation, reconciliation, and outbound delivery. One-shot ticks
run the configured pipelines and poke the activation-scheduler processor at
the documented boundary.

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
`EventProcessorHost` or concrete processor serialisers. The Eventing filesystem
package supplies storage and keyed serialisation only; Bootstrap alone composes
the complete registry.

## Configuration and scenarios

Root sections are `work`, `resources`, `activities`, `orchestration`,
`execution`, `controlPlane`, `integrations`, `surfaces`, `transcripts`, and
`host`. Runtime paths are resolved below `.wake/`, with workspaces below
`workspaces/`.

E2E-CONFIG-001, E2E-OPS-INIT-001, E2E-OPS-001.
