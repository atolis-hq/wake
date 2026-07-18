# Work identity and correlation vocabulary: design

* Date: 2026-07-16
* Status: approved
* Implements: [work graph implementation plan](../../plans/2026-07-12-work-graph-implementation-plan.md) §1, §2, §4 (the "do now" set)
* Governed by: [ADR 0001](../../adrs/0001-correlating-external-resources-to-work-items.md), [resource-correlation implementation handoff](../../handoffs/2026-07-12-resource-correlation-implementation.md)
* Conceptual model: [work-graph handoff](../../handoffs/wake-work-graph-handoff.md)

## Purpose

Replace Wake's ticket-coupled work identity with a provider-independent minted work ID, and lock the durable correlation event shapes. Both are expensive to change once real event history accumulates — the plan's split rule puts them first for exactly that reason, and the one-time sanctioned fresh start of `.wake/` is what makes doing them now cheap.

This change is scoped to identity and durable event vocabulary. It is deliberately *not* the correlation feature set: the first real consumer (#82, PR activity) is separate and later.

## Prerequisites (already met)

* #54 (unified echo suppression) — CLOSED
* #76 (PR exclusion moved to policy engine) — CLOSED

## Governing decisions and divergences

Two places where the source documents disagree. Both are resolved here; the resolutions are binding on implementation.

### D1. Discovery sources do not self-key (plan supersedes ADR)

ADR 0001 §5 (line 147) states originating-ticket sources "mint new work items and keep self-keying". The implementation plan §1 states the opposite: resolution is uniform through the reverse index, with "no founding-surface special case".

**Resolved: the plan governs.** It is later, and is specifically about identity. Self-keying is the degenerate special case §1 exists to remove.

**Consequence the plan understates:** uniform resolution *is* a central resolver step. The plan files the resolver under §3 (bundled with #82). A minimal resolver must therefore land now. The watchlist half of C3, and activity sources, still defer.

### D2. Branch-name detection survives the opaque work ID

ADR 0001 §4 (line 131) and the plan §4 (line 57) both rely on "the deterministic branch convention already identifies the work item", while branches derive from `repo` + `issueNumber`. This appears to contradict §1's "no path or key embeds a provider, repo, or issue number".

**Resolved: no contradiction.** A branch yields `repo` + `issueNumber`, from which the URI `github:issue:<repo>#<N>` is constructed and resolved through the reverse index to the work ID. The branch does not need to *contain* the work ID; it needs to name a resource the registry knows. This is the same one-mechanism resolution §1 is built on.

The "no repo/issue in paths" rule binds `.wake/` durable storage. Git branches are provider-facing artifacts, not Wake state, and stay human-readable.

Note: the work-graph handoff's §7 `CorrelationRegistered` code sample (lines 396-407) omits `provenance` and is stale. ADR 0001 §2 governs the payload shape.

### D3. Why identity is minted rather than the originating ticket

The source documents assert minted identity without arguing for it (the handoff's "no external surface ID is the work's identity", line 916). The question "why is work not simply named by its ticket?" is the obvious one and was raised during review; recording the answer so it is not re-litigated.

**The case rests on ticket keys not being stable names for work over its whole life:**

* **Ticket mutation.** Transferring a GitHub issue between repos assigns a *new number in the target repo*. Under ticket-identity that is not a rename but a different key: stream, projection path, and accumulated history orphan, and Wake mints a fresh work item for work already in flight. Provider migration (Jira → Linear) has the same shape.
* **Cardinality.** Work splits, or two tickets prove to be one job. If the ticket *is* the identity, a merge is unrepresentable — one lifecycle cannot hold two keys. Ticket-identity forecloses the deferred work-to-work topology layer rather than deferring it.
* **Multiple representations.** A Jira epic mirrored to a GitHub issue: both are representations, neither privileged. Ticket-identity forces an arbitrary winner.

**What does *not* justify it:** "uniform resolution, no founding-surface special case" and "complete `correlatedResources[]`" are cited by the plan (§1) but are achievable *without* minting — a ticket-shaped key plus representation auto-registration yields both. Do not rely on those arguments; the case is the three points above and nothing else.

**Accepted cost:** work IDs are opaque. `work-01JXYZ` in a log line conveys nothing without a lookup, and `state/<workId>.json` is not greppable by issue number. This is a real, daily operator tax. No lookup affordance is being built (deliberate YAGNI, decided at review); the reverse index shards serve for manual debugging.

**Why it is accepted:** asymmetry, not frequency. If minting proves unnecessary, the cost is readability and some indirection. If ticket-identity proves wrong, it surfaces on the first transfer — and the remedy is a migration over accumulated history, precisely what this plan exists to avoid. The fresh-start pass is free now and shrinks as history accrues.

## Design

### 1. Identity and minting

* Work IDs are `work-<ulid>`, e.g. `work-01JXYZ...`, minted via the `ulid` package (new dependency).
* ULIDs are lexicographically sortable by mint time, so `state/` listings are naturally chronological.
* A work item is minted when an inbound resource URI **fails to resolve** in the reverse index. A miss means "mint"; there is no other trigger.
* Minting appends, in order:
  1. `wake.workitem.created`
  2. `wake.correlation.registered` for the originating ticket (`role: representation`, `relation: primary`, `provenance: wake-created`)
* `workItemKey` **keeps its name** as the envelope/projection field. Only its value changes, from `<source>:<repo>#<number>` to `work-<ulid>`. Do not rename the field.
* `correlatedResources[]` is therefore a complete inventory from the first event, with no special case for the founding surface.

### 2. `WorkSource` seam change

Today `github-issues-work-source.ts` and `fake-ticketing-system.ts` build `workItemKey` themselves. Under D1 they must stop.

* `pollEvents()` returns **unkeyed** events: an envelope shape minus `workItemKey`, carrying `sourceRefs.resourceUri` instead (e.g. `github:issue:atolis-hq/wake#82`).
* A resolver step in `tick-runner.ts`, between `pollEvents()` and `appendEventEnvelope`, resolves the URI to a work ID (minting on miss) and stamps `workItemKey`.
* Sources have **no** obligation to know the work item and **no** read access to core state (handoff invariant 2).
* The fake moves symmetrically and must genuinely exercise the unkeyed path.

This is the minimal resolver. It does **not** include watchlists (`pollEvents({ watch })`), which stay deferred.

### 3. Storage layout

| What | Path |
|---|---|
| Projection | `state/<workId>.json` |
| Archived projection | `state/archive/<workId>.json` |
| Reverse index | `state/index/<xx>.json` (256 hash shards) |
| Workspace | keyed by `workId` |
| Transcripts | keyed by `workId` |
| Events, runs, source cursors | unchanged (keyed by date / runId / source name) |

No path parses a provider, repo, or issue segment.

`workspaceDir` and the transcript dirs are ephemeral scratch, not durable `.wake/` state, but they re-key to `workId` anyway: they are 1:1 with a work item rather than a ticket, and leaving them ticket-shaped would preserve a second ticket-shaped identity — the thing §1 exists to remove — and would break for any future non-ticket work item.

### 4. Reverse index: hash-sharded JSON

The index maps `resourceUri → workItemKey`.

**It must be complete and unbounded.** It cannot be scoped to active work: activity can arrive on a resource belonging to long-closed work (a comment on an old PR), and a *miss* means "mint a new work item". An incomplete index does not degrade gracefully — it silently forks a second work item for existing work, which is the corruption invariant 3 warns about.

**Sharding scheme:**

* `sha256(resourceUri)` (from `node:crypto`), take the first 2 hex characters → one of 256 shards at `state/index/<xx>.json`.
* Each shard holds `{ "<resourceUri>": "<workItemKey>" }` entries; reads match on the **full URI string**, so shard collisions are expected and harmless.
* Resolution reads **one** shard. Registration rewrites **one** shard. Per-event cost stays flat as history grows, rather than tracking total history.

**Why hashing rather than the URI as a filename:** a `resourceUri` contains `/`, `#`, and `:`, so using it as a filename requires escaping — which smuggles locator parsing into core, violating "core compares URIs for equality only, never parses a locator". Hashing consumes the URI as opaque bytes and never observes its `<provider>:<kind>:<locator>` structure. Compliant, and valid filenames for free.

**It is a cache.** Deleting `state/index/` and replaying `events/` must rebuild every shard identically (ADR confirmation criterion #2). Use the existing file locking in `lib/`.

### 5. Durable event shapes (locked)

These go into append-only streams and are the expensive-to-change part.

```jsonc
// sourceEventType: "wake.workitem.created"
{ "workItemKey": "work-01JXYZ", "payload": { } }
```

```jsonc
// sourceEventType: "wake.correlation.registered"
{
  "workItemKey": "work-01JXYZ",
  "payload": {
    "resourceUri": "github:pr:atolis-hq/wake#91",
    "role": "implementation",       // representation | implementation | discussion | review | documentation | decision
    "relation": "primary",          // primary | secondary
    "provenance": "operator-declared", // wake-created | agent-reported | detected | operator-declared
    "registeredBy": "run-…"
  }
}
```

```jsonc
// sourceEventType: "wake.correlation.retracted"
{ "workItemKey": "work-01JXYZ", "payload": { "resourceUri": "github:pr:atolis-hq/wake#91" } }
```

* Resource URI grammar: `<provider>:<kind>:<locator>`. `provider` equals the adapter's registered name. `kind` uses provider-native terms (`github:pr:…`, `gitlab:mr:…`). Core compares for equality only.
* `role` is Wake-owned relationship vocabulary, never provider terms. New providers add URI kinds, not roles.
* `sourceRefs` gains **one** optional field, `resourceUri`. It stays per-event provenance; item-level ownership lives only in the registry.
* Fold is last-write-wins per `resourceUri`. Registration is idempotent: re-registering an existing `(workItemKey, resourceUri)` pair is a no-op at fold time.

### 6. One-primary-per-URI enforcement

The fold enforces it: a second `primary` registration on a claimed URI is **downgraded to `secondary`** and a warning event appended. Promotion requires explicit retraction of the incumbent first.

This is technically a projection concern and therefore deferrable, but `wake correlate` gives operators a live path to double-claim a URI, and the handoff calls silent re-mapping corruption rather than a merge. Included deliberately; leaving the index unguarded is worse than the small cost.

### 7. Operator command and markers

* `wake correlate <workItemKey> <resourceUri>` emits the same `wake.correlation.registered` event with `provenance: operator-declared`. This is the escape hatch that makes every gap adoptable by hand rather than blocking.
* PR bodies carry `<!-- wake:work-item <workId> -->`, added to the prompt template (same family as the existing `<!-- wake:agent -->` echo marker).
* Markers are **written, not read**. No detection scanner is built — the plan defers scanning precisely because markers written from day one let scanning recover history whenever it lands.

### 8. Deletions

This change is net-simplifying. Remove:

* All three copies of the `split on ':'` parse: `sourceFromWorkItemKey` (`domain/schema.ts`, `core/projection-updater.ts`) and `issueRefFromWorkItemKey` (`adapters/fs/state-store.ts`).
* `namespacedWorkItemKey` (both the `domain/schema.ts` and `adapters/fs/state-store.ts` copies) and its `.transform()` on every envelope and projection parse.
* `legacyIssueStateFile` / `archivedLegacyIssueStateFile` in `lib/paths.ts`.
* The `issueStateRecordSchema` legacy `.preprocess()` normalization.

The fresh start means no migration code and no back-compat. Do not write either.

### 9. Retained deliberately

The projection keeps its `issue` snapshot and `origin` field. They stop driving path decisions but remain as cached representation content. Removing them is a separate concern and out of scope.

## Fresh-start cutover

Per the plan. **Operator-run, not automated — no cutover code is written.**

1. Stop the resident loop.
2. Archive the entire `.wake/` home (events, state, runs, ledger) — kept for reference, never read by new code.
3. Re-scaffold a clean Wake home.
4. Open work in GitHub is re-discovered on the first tick and minted fresh work IDs. In-flight items lose local attempt history — acceptable; the backlog is small and GitHub retains the human-visible record.

## Out of scope

Explicitly not built here. Each is deferred by the plan's Defer table or bundled with #82:

* Watchlists (`pollEvents({ watch })`) and `createGitHubPullRequestActivitySource`
* Runner-result `artifacts` block and provider verification before registration
* Per-`resourceUri` echo suppression; `resourceUri` sink routing
* Graph projection store; work-to-work topology events
* Context delivery modes (`materialized` / `by-reference`) — `inline` only
* Detection scanning
* Secondary-relation policy beyond context-only fan-out
* Migration tooling and schema-versioning discipline

## Testing

* Exercise `core/` through the fakes (`createFakeRunner`, `createFileBackedFakeTicketingSystem`, `createFakeWorkspaceManager`), per repo convention — not ad hoc mocks of `core/contracts.ts`.
* **Rebuild test is the keystone:** delete `state/` entirely, replay `events/`, assert the projection, `correlatedResources[]`, and every index shard reproduce exactly. This is ADR confirmation criterion #2 and the guard on the whole "index is a cache" claim.
* Resolver: hit resolves to existing work ID; miss mints exactly one work item and emits both events in order; the same URI arriving twice does not mint twice.
* Fold: idempotent re-registration; retraction; second-primary downgrade plus warning event.
* Shard determinism: the same URI maps to the same shard across processes.
* Heaviest existing test rework: `test/adapters/state-store.test.ts` (physical path assertions) and `test/domain/schema.test.ts` (key-transform assertions) — both encode the `<source>:<repo>#<number>` grammar most directly.

## Documentation to update

Required by CLAUDE.md when the CLI or config surface changes:

* `README.md` / `docs/configuration.md` — the `wake correlate` command.
* `docs/architecture.md` (lines ~31, ~120) — still documents `state/<repo>/<issue>.json` as current.
* `docs/handoffs/2026-07-05-event-first-persistence.md` (line ~23) — same stale path.

## Acceptance

1. A GitHub issue discovered on a clean Wake home mints `work-<ulid>`, emits `wake.workitem.created` + a `representation`/`primary`/`wake-created` registration, and lands at `state/<workId>.json`.
2. A second event on the same issue resolves through the index to the same work ID and mints nothing.
3. `rm -rf state/` + replay reproduces the projection, registry, and all index shards exactly.
4. `wake correlate <workId> github:pr:atolis-hq/wake#91` registers with `provenance: operator-declared` and appears in `correlatedResources[]`.
5. A second `primary` registration on a claimed URI folds to `secondary` and appends a warning event.
6. No source constructs a `workItemKey`; no path or durable key embeds a provider, repo, or issue number.
7. `npm run verify` passes.
