# Work graph implementation plan: now vs later

* Date: 2026-07-12
* Status: proposed
* Builds on: [ADR 0001](../adrs/0001-correlating-external-resources-to-work-items.md) (correlation registry), [work-graph handoff](../handoffs/wake-work-graph-handoff.md) (conceptual model), [resource-correlation implementation handoff](../handoffs/2026-07-12-resource-correlation-implementation.md) (invariants)
* Related issues: [#54](https://github.com/atolis-hq/wake/issues/54) (echo suppression), [#76](https://github.com/atolis-hq/wake/issues/76) (PR exclusion → policy engine), [#82](https://github.com/atolis-hq/wake/issues/82) (PR activity source)

## Scope guard: a sound model, not a work-graph product

Established products already own the work-graph-as-product space — Asana's work graph, Atlassian's Teamwork Graph, Linear's project relations. Wake is not competing with them. Wake's graph exists for one purpose: **coordinating its own autonomous work** — correlating surfaces, assembling context for agent runs, routing replies, and eventually sequencing dependent work. It is not a portfolio view, a reporting product, or an organisational knowledge base.

The practical consequences:

* Wake models only the identities and relationships it needs to coordinate (the [handoff's](../handoffs/wake-work-graph-handoff.md) "selective projection" guidance).
* Where an organisation already runs a graph-bearing tool, Wake should be able to **plug in** through the existing adapter seams — a Jira/Asana source is a `WorkSource`, and externally-maintained relationships can enter as correlation/topology events with `provenance: detected` or `operator-declared`. Wake never needs to be the system of record for a team's planning graph.
* The deliverable of this plan is a *sound internal model* — identity, event shapes, and layering that won't need rework — not graph features.

## The split rule

Wake's durability model dictates what must be right early:

* **Events are append-only and forever.** Anything that fixes the shape of durable events — identity keys, event types, field vocabularies — is expensive to change once real history accumulates.
* **Projections are rebuildable.** Anything that is a fold, index, query, or policy over events can be added, changed, or rewritten later at the cost of a replay.

So: **"now" work is whatever shapes durable identity and events; "later" work is projections and policy.** One further forcing function: a **fresh start is sanctioned once, now** — the existing `.wake/` home is archived and a clean one starts on the new model, with no migration code. That free pass shrinks as Wake accumulates history we care about keeping, so identity-shaping work lands first.

## Do now (priority: avoid rework)

### 1. Internal work identity + key-agnostic storage (the structural change)

The one change that becomes a real migration if delayed. Today identity is physically coupled to the originating ticket: `workItemKey` is `<source>:<repo>#<number>` and projections live at `state/<source>/<repo>/<issue>.json` (`src/lib/paths.ts`).

* Mint a provider-independent work ID (e.g. `work-<ulid>`) when a discovery source first surfaces a ticket; emit it in a work-creation event.
* `workItemKey` (the envelope/projection field) carries the work ID. Streams, projections, and run records are keyed by it; the path layout becomes `state/<workId>.json` with no parsed repo/issue segments.
* The originating ticket is resolved to its work item through the **same reverse index** (`resourceUri → workItemKey`) used for PRs and threads — discovery-source reconciliation (labels, assignment) is just correlation lookup, with "no entry" meaning "mint a new work item". One resolution mechanism, no founding-surface special case.

### 2. Correlation event vocabulary (locked durable shapes)

Per ADR 0001, these shapes go into append-only streams, so they are finalized now even though most consumers come later:

* `wake.correlation.registered` / `wake.correlation.retracted` with `resourceUri`, `role` (Wake-owned vocabulary: `representation | implementation | discussion | review | documentation | decision`), `relation: primary | secondary`, `provenance`, `registeredBy`.
* Resource URI grammar `<provider>:<kind>:<locator>`; core compares URIs for equality only and never parses a locator.
* `sourceRefs` gains the optional `resourceUri` field.
* Originating-ticket auto-registration (`role: representation`, `relation: primary`, `provenance: wake-created`) at work-item creation — this is what makes item 1's uniform resolution work.

### 3. Correlation core, bundled with #82

The seam changes land together with the first consumer so fakes and reals move in one step (see the [implementation handoff](../handoffs/2026-07-12-resource-correlation-implementation.md) for invariants):

* `WorkSource.pollEvents({ watch })` watchlists; central resolver in `tick-runner.ts` between poll and append; unresolved events to `global-intake`.
* Separate `createGitHubPullRequestActivitySource` adapter.
* Runner-result `artifacts` block with provider verification before registration (all runners + fake, symmetric).
* Per-`resourceUri` echo suppression (#54) and PR exclusion in the policy engine (#76) land first — both are prerequisites.

### 4. Cheap insurance that only works if done from day one

* **Embedded markers**: `<!-- wake:work-item <key> -->` in Wake-influenced PR bodies; the deterministic branch convention already identifies the work item. Writing markers costs nothing now; artifacts created without them are permanently orphan-prone.
* **`wake correlate <workItemKey> <resourceUri>`** operator command — the escape hatch that makes every gap in the above adoptable by hand instead of blocking.

## Fresh-start cutover

1. Stop the resident loop; archive the entire `.wake/` home (events, state, runs, ledger) — kept for reference, never read by the new code.
2. Re-scaffold a clean Wake home.
3. Open work in GitHub is re-discovered on the first tick and minted fresh work IDs; in-flight items lose local attempt history (acceptable — the backlog is small and GitHub retains the human-visible record).
4. No migration code is written or kept.

## Defer (safe to add later by replay or extension)

| Deferred work | Why it can wait |
|---|---|
| Work-to-work topology events (`DependencyAdded`, `WorkSplit`, `FollowUpWorkCreated`, `WorkSuperseded`) and any policy over them | New event types extend the model without reshaping anything; no consumer exists yet |
| Graph projection store (nodes/edges tables, multi-hop queries) | `correlatedResources[]` + reverse index serve #82; build a store when a real query needs it, rebuilt from events |
| Context delivery modes `materialized` / `by-reference` | Inline covers conversational surfaces; revisit with the first large-content adapter (Jira/Confluence) |
| Detection *scanning* (polling for unregistered marked artifacts) | Markers are being written from day one (§4), so scanning recovers history whenever it lands |
| Secondary-relation policy behavior beyond context-only fan-out | Explicitly deferred by ADR 0001 |
| Quorum software-impact layer | Longer-term; separate design once Quorum's graph is consumable |
| External work-graph tool integration (Asana, Atlassian Teamwork Graph, Linear relations) | Plug-in via adapters when needed; per the scope guard, never a build-out |
| Migration tooling and schema versioning discipline | Not needed for the fresh start; becomes necessary the first time a durable-record change lands on data we want to keep |

## Sequencing

```text
#54 (echo suppression)  ─┐
#76 (PR exclusion)      ─┤→  identity cutover + fresh start (§1, §2, §4)  →  #82 (correlation core, §3)  →  deferred items on demand
```

Identity lands before #82: building the PR activity source against ticket-shaped keys and re-keying it afterwards is exactly the rework this plan exists to avoid.
