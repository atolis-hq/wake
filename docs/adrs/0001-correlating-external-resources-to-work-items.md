# Correlating external resources and conversation surfaces to a canonical work item

* Status: proposed
* Deciders: jmenziessmith
* Date: 2026-07-12
* Informed by: [Issue #82](https://github.com/atolis-hq/wake/issues/82) (PR activity source), [Issue #54](https://github.com/atolis-hq/wake/issues/54) (unified echo suppression), [Issue #70](https://github.com/atolis-hq/wake/issues/70) (sink router), [Issue #76](https://github.com/atolis-hq/wake/issues/76) (PR exclusion moves to policy engine), [work-graph handoff](../handoffs/wake-work-graph-handoff.md) (conceptual direction)

## Context and Problem Statement

<<<<<<< HEAD
A Wake work item starts life as a single ticket (today: a GitHub issue), but the work it drives quickly sprawls across other resources: an agent opens a PR from the issue; a human reviews that PR; a Slack thread discusses the issue or the PR; in future, a GitHub PR or GitLab merge request may be raised from a Jira or Linear issue. Each of these surfaces has its own provider, its own identifier scheme, and its own conversation thread — yet all of them are facets of **one** unit of work with **one** lifecycle.
=======
A Wake work item starts life as a single ticket (today: a GitHub issue), but the work it drives quickly sprawls across other resources: an agent opens a PR from the issue; a human reviews that PR; a Slack thread discusses the issue or the PR; in future, a GitHub PR or GitLab merge request may be raised from a Jira or Linear issue. Each of these surfaces has its own provider, its own identifier scheme, and its own conversation thread — yet all of them are facets of **one** unit of work with **one** lifecycle.
>>>>>>> d6494b7 (Add ADR 0001: correlating external resources to work items)

Today Wake has no durable record of "work item X owns resources A, B, C":

* `workItemKey` (`<source>:<repo>#<number>`, e.g. `github:atolis-hq/wake#82`) canonically identifies the originating ticket — and nothing else.
* `sourceRefs` on each event envelope (`repo`, `issueNumber`, `commentId`, `reviewId`, `runId`, `sink`, `sourceUrl`) describes where **one event** came from, not what the work item owns.
* When an agent creates a PR, the PR number/URL appears only as free text in the agent's output and outbound comments. Wake cannot deterministically answer "which work item does PR #91 belong to?" — which is exactly the question a PR-activity source must answer for every comment and review it polls.

The correlation record is not only routing plumbing — it is what makes the work item *whole*. Wake prompts agents with a compact projection summary plus recent events, and resumes prior CLI sessions rather than starting cold. Both of those only work if Wake can enumerate every surface a piece of work touched: an agent resumed from a PR review comment needs the issue thread, the earlier review rounds, and any side discussion as context, regardless of which surface triggered the resume. Without a consolidated identity record, each new surface fragments the context Wake can assemble.

How should Wake reliably correlate identifiers from multiple external sources and adapters back to the canonical work item, so that (a) activity on any correlated surface resumes the right lifecycle with full accumulated context, and (b) replies route back to the surface that triggered them?

## Decision Drivers

* **One lifecycle per work item.** PR review feedback must resume the *issue's* stage machine, not spawn a sibling lifecycle (see `docs/architecture.md`; stages live in `src/domain/stages.ts`).
* **Full-context resumption from anywhere.** Whichever surface triggers a run, Wake must be able to assemble the complete picture — issue thread, PRs, review threads, side discussions — into the prompt/session it resumes. Consolidated correlation is the index that makes this possible.
* **Cardinality is not 1:1.** One issue may accumulate several PRs (an abandoned attempt plus its replacement is routine) and several discussion threads; conversely a single PR may claim to address two issues (poor practice, but it happens). The model must represent many-per-item cleanly and shared-resource cases deliberately, not by accident of a uniqueness constraint.
* **Not every work item is a code change, and not every resource fits in a prompt.** A task may be "create or review a Jira/Confluence page (or several)", with comments to read and answer. Correlated resources can be large content artifacts whose wholesale injection into prompts is prohibitively expensive. Correlation must therefore not imply any particular content-delivery mechanism.
<<<<<<< HEAD
* **Provider-agnostic by construction.** The mechanism decided here must work unchanged for GitHub PRs, Slack threads, Jira/Linear tickets, and GitLab merge requests — new surfaces must not require core schema changes.
=======
* **Provider-agnostic by construction.** The mechanism decided here must work unchanged for GitHub PRs, Slack threads, Jira/Linear tickets, and GitLab merge requests — new surfaces must not require core schema changes.
>>>>>>> d6494b7 (Add ADR 0001: correlating external resources to work items)
* **The tick is a pure function of durable state.** Correlation must be persisted as events under `.wake/` and be rebuildable from the event stream, like every other projection (CLAUDE.md invariant).
* **Wake decides, the agent runs.** The agent must not become responsible for routing or state; whatever the agent contributes to correlation must be a parsed, validated output — like the existing sentinel contract.
* **Adapters stay behind seams.** Sources/sinks implement `src/core/contracts.ts` interfaces; `core/` never imports a concrete adapter. Correlation must not leak provider knowledge into core, nor core state into adapters.
* **Humans act out-of-band.** A human (or an agent with shell access) can create a PR, thread, or link outside any contract Wake defines. The design must degrade gracefully rather than lose track of work.
* **Echo suppression must generalize.** Every new surface is a new place Wake can hear its own voice; correlation metadata must make suppression (#54) uniform rather than per-surface ad hoc.

## Considered Options

### A. Correlation mechanism

* **A1. Contract-first, detection fallback** — structured registration events are the contract; marker/link detection is a recovery path only.
* **A2. Strong contract only** — resources not registered through the contract are not part of the work item.
* **A3. Detection-first** — Wake infers correlation by scanning artifacts for embedded markers, links, and conventions.

### B. Identity model

* **B1. Canonical key + correlation registry** — one canonical `workItemKey`; a durable, event-sourced registry of correlated resource identities.
* **B2. Extend `sourceRefs` / projection fields per surface** — add `pullRequestNumber`, `slackThreadTs`, … as needed.
* **B3. Peer work items + link events** — every surface is its own work item; correlation is a graph of links.

### C. Resolution placement (sub-decision of B1)

* **C1. Resolution in each source adapter** — adapters query the registry and emit events already keyed to the canonical `workItemKey`.
* **C2. Central resolver in core ingestion** — adapters emit provenance only; core resolves `resourceUri → workItemKey` between poll and append.
* **C3. Central resolver + registry-derived watchlists** — as C2, plus core hands each source a plain-data list of resources to watch, derived from the registry.

## Decision Outcome

Chosen: **A1 + B1 + C3** — a contract-first correlation registry keyed by provider-agnostic resource URIs, resolved centrally at ingestion, with registry-derived watchlists driving source polling and marker-based detection as the recovery path.

**Framing: the registry is the first layer of a work graph.** The [work-graph handoff](../handoffs/wake-work-graph-handoff.md) describes the broader model this decision serves: a work item is a durable unit of work of which the originating ticket is only one *representation*, and its relationships to surfaces, artifacts, executions, and other work form a graph projected from the event stream. The registry defined below is that graph's work-to-surface layer — each registration is a typed edge from the work item to a resource node, with the resource URI as the node's identity and `role` as the edge type — built with today's vocabulary and no new storage. Later layers (work-to-work topology, software impact) extend the same event-sourced model with further edge kinds. Resources are nodes, not peer work items: only work items carry a lifecycle (which is why B3 is rejected).

### 1. Resource URIs: one identifier grammar for every surface

Every external resource Wake correlates is named by a **resource URI**:

```
<provider>:<kind>:<locator>
```

| Example | Meaning |
|---|---|
| `github:issue:atolis-hq/wake#82` | the originating GitHub issue |
| `github:pr:atolis-hq/wake#91` | a GitHub pull request |
| `github:pr-review-thread:atolis-hq/wake#91/rt_123` | a specific review comment thread on that PR |
| `slack:thread:C0123/1699999999.000042` | a Slack thread (channel + root ts) |
| `jira:issue:WAKE-12` | a Jira ticket |
<<<<<<< HEAD
| `gitlab:mr:team/repo!7` | a GitLab merge request (GitLab's own `!` notation; the `kind` is `mr`, not `pr` — each provider's `kind` vocabulary uses that provider's native terms) |
=======
| `gitlab:mr:team/repo!7` | a GitLab merge request (GitLab's own `!` notation; the `kind` is `mr`, not `pr` — each provider's `kind` vocabulary uses that provider's native terms) |
>>>>>>> d6494b7 (Add ADR 0001: correlating external resources to work items)

Rules:

* The `provider` segment matches the source/sink adapter's registered name; the `kind` vocabulary is owned by the adapter but must be stable (it drives routing and prompt rendering).
* The `locator` grammar is provider-specific and opaque to core; core only ever compares URIs for equality and passes them back to the owning adapter.
* The canonical `workItemKey` names the *work*, not any surface: its value is a provider-independent work ID (e.g. `work-01JXYZ`) minted when a discovery source first surfaces a ticket. The originating ticket is the work's primary **representation** — one registered resource among others (see §3) — and is resolved to its work item through the same reverse index as every other correlated resource. Streams, projections, and run records are keyed by the work ID, so no path or key ever embeds a provider, repo, or issue number. The cutover from today's ticket-shaped keys is a one-time fresh start, not a migration (see the [implementation plan](../plans/2026-07-12-work-graph-implementation-plan.md)).

### 2. The correlation registry: an event-sourced alias table

A new internal event type registers a resource against a work item:

```jsonc
// sourceEventType: "wake.correlation.registered"
{
  "workItemKey": "github:atolis-hq/wake#82",
  "payload": {
    "resourceUri": "github:pr:atolis-hq/wake#91",
    "role": "implementation",        // representation | implementation | discussion | review | documentation | decision | ...
    "relation": "primary",           // primary | secondary — see Cardinality below
    "provenance": "agent-reported",  // wake-created | agent-reported | detected | operator-declared
    "registeredBy": "run-82-1783798187999"
  }
}
```

* `role` is the graph edge type and uses a **Wake-owned relationship vocabulary**, deliberately independent of the URI's provider-native `kind`: a `github:pr:…` and a `gitlab:mr:…` both register with `role: implementation`. A new provider adds URI kinds, never new roles; a new role is a Wake modelling decision, not an adapter one. Provider-specific identity lives on the resource URI; relationship semantics live on the edge.
* `projection-updater.ts` folds these into a `correlatedResources[]` array on the per-work-item projection under `state/`, alongside a rebuildable reverse index `resourceUri → workItemKey`. Like all of `state/`, the index is a cache over `events/` — deleting it must be harmless.
* A matching `wake.correlation.retracted` event handles the rare correction case (wrong PR registered, thread archived); the fold is last-write-wins per `resourceUri`.
* Registration is idempotent: re-registering an existing `(workItemKey, resourceUri)` pair is a no-op at fold time, so contract and detection paths can both fire without conflict.

**Cardinality.** The registry is a many-to-many relation with an ownership rule, not a 1:1 alias table:

* *Many resources per work item is the normal case.* An issue routinely accumulates multiple PRs (a superseded attempt plus its replacement), multiple review threads, and multiple discussions — `correlatedResources[]` is a list precisely for this. Registrations carry the `role`, and a superseded artifact is retracted or left registered as historical context rather than deleted; full-context assembly wants the history, not just the current head.
* *One resource shared across work items is allowed but asymmetric.* Each registration carries a `relation: primary | secondary` field (default `primary`). Per `resourceUri`, **exactly one work item may hold the `primary` relation** — that item owns lifecycle resumption and reply routing for activity on the resource. Any number of items may register the same URI as `secondary`: inbound activity on the resource fans out to their event streams with `trigger: context-only` (the existing envelope vocabulary), enriching their context without waking their lifecycles. A PR claiming to close two issues thus resumes one issue's stage machine and merely informs the other — deliberate, inspectable behavior instead of either a hard rejection or an ambiguous double-resume.
* A registration attempting a second `primary` on an already-claimed URI is folded as `secondary` and surfaced as a warning event; promoting a secondary to primary requires an explicit retraction of the incumbent first. Silent re-mapping would move conversation history between work items.

`sourceRefs` keeps its current job — per-event provenance — and gains one optional field, `resourceUri`, identifying which correlated surface an event occurred on. The registry (item → resources) and `sourceRefs` (event → origin) are complementary layers, not competitors.

### 3. How resources get registered (the contract half)

First, one registration is automatic: when a discovery source mints a new work item, the tick runner registers the **originating ticket itself** (`role: representation`, `relation: primary`, `provenance: wake-created`). This costs one event and makes `correlatedResources[]` a *complete* inventory — context assembly, routing, and any future graph projection enumerate every surface uniformly, with no special case for the founding one. It also means discovery-source reconciliation (mapping an inbound issue event to its work item) is the same reverse-index lookup used for every other surface; a miss means "mint a new work item".

Beyond that, three conforming registration flows, chosen per artifact type — codifying that **who creates an artifact is a per-adapter/per-artifact decision**, while the registration contract is invariant:

1. **Wake-created artifacts.** When a sink adapter creates a resource on Wake's behalf (posting a Slack thread, or a future adapter opening a PR from an agent-pushed branch), the sink returns the provider identifiers in its delivery events — the same path that today returns provider comment IDs for echo suppression — and the tick runner appends the `wake.correlation.registered` event. This is the default for conversational surfaces: **the agent must not create Slack messages**; it emits a publish intent describing the message, Wake delivers it and records the resulting thread identity.
2. **Agent-created, structurally reported.** For artifacts the agent is better placed to create (today: PRs, via `gh` in its workspace), the runner result contract gains a structured `artifacts` section parsed exactly like sentinels (`domain/schema.ts`): the agent reports `{ kind: "pr", url: ... }` in a fenced, machine-readable block; the runner parses it, Wake **verifies the artifact against the provider** (the adapter resolves the URL to a live resource and checks the branch matches the run's workspace branch) and only then registers it. An unverifiable claim is treated like a malformed sentinel — the run result is suspect, not silently trusted.
3. **Operator-declared.** A human can attach an existing resource to a work item explicitly (CLI/UI affordance, e.g. `wake correlate <workItemKey> <resourceUri>`), producing the same event with `provenance: operator-declared`. This is the escape hatch that keeps out-of-band work adoptable without waiting for detection.

All three flows converge on the identical event; downstream (projection, routing, prompts) never needs to know which flow produced a correlation.

### 4. Detection as fallback, not foundation

Detection recovers correlations the contract missed — crash between artifact creation and registration, humans acting out-of-band — and is deliberately second-class:

* **Embedded markers.** Wake-influenced artifacts carry the work item key in provider-visible metadata: PR bodies get a hidden marker (`<!-- wake:work-item github:atolis-hq/wake#82 -->`, the same family as the existing `<!-- wake:agent -->` echo marker); branch names follow the existing deterministic convention (`WorkspaceManager` derives them from `repo` + `issueNumber`, so a PR's head branch alone identifies the work item).
* **Provider link conventions.** `Closes #82` / cross-reference links are accepted as *hints* that surface a proposed correlation, never as automatic registration — they are too easy to produce accidentally.
* Anything detection finds is registered through the same `wake.correlation.registered` event with `provenance: detected`, so recovery is indistinguishable downstream from the contract path.

Detection-first as the primary mechanism (option A3) is rejected: it is probabilistic, provider-specific by nature, and puts parsing conventions in the trust path for lifecycle decisions. Contract-only (A2) is rejected because "not registered → not ours" silently orphans real work the moment a human steps outside the flow; that failure mode is worse than the modest cost of a marker/detector.

### 5. Resolution placement: central resolver + registry-derived watchlists (C3)

Ingestion today (`tick-runner.ts`) is: `workSource.pollEvents()` → append envelopes → rebuild projections. Envelopes are keyed by `workItemKey` at append time, so resolution must complete between poll and append.

* **C1 (resolve in each adapter) — rejected.** Every source adapter would re-implement registry lookup, each fake would need to mirror it, and adapters would gain a read dependency on core state — inverting the seam direction the architecture protects. The GitHub-issues source only gets away with self-keying today because for it, resource and work item are the same object; that is a degenerate special case, not a pattern.
* **C2 (central resolver only) — insufficient alone.** It fixes the seam, but leaves open how a PR/Slack source knows *what to poll*. Polling every PR in every repo (or every Slack channel) and discarding unresolvable events is wasteful and rate-limit hostile.
* **C3 — chosen.** Two complementary halves:
  * *Watchlists drive polling.* Before polling, the tick runner derives, per source provider, the list of resource URIs currently correlated to open work items, and passes it to the source as plain data (an addition to the `WorkSource` seam, e.g. `pollEvents({ watch: ResourceRef[] })`). Sources poll only what the registry says matters; they never touch the registry itself. The fake ticketing system implements the same signature, keeping the zero-token test path honest.
  * *Core resolves before append.* Sources return events carrying `sourceRefs.resourceUri` and provenance, with no obligation to know the work item. A resolver step in the tick runner looks up the URI in the registry index, stamps the *primary* work item's canonical key before `appendEventEnvelope`, and appends `trigger: context-only` copies to any secondary items' streams. Since watchlists were registry-derived, resolution normally always succeeds; an event that still fails to resolve (e.g. a detection hint on an unknown PR) is appended under `streamScope: global-intake` as an unresolved-activity event rather than dropped — visible, replayable, and adoptable later via flow 3 above.

Note the originating-ticket sources (GitHub issues today, Jira/Linear later) are *discovery* sources — they mint new work items and keep self-keying. Watchlist-driven sources are *activity* sources over already-correlated resources. The `WorkSource` interface serves both; the distinction is which arguments they use. This also satisfies the requirement from #82's review that PR activity be a **separately defined source adapter** (e.g. `createGitHubPullRequestActivitySource`), sharing the GitHub client with the issues source but implementing its own seam.

### 6. Reply routing falls out of correlation

The sink router (`src/core/sink-router.ts`) already routes publish intents back to `sourceRefs.sink`. With `resourceUri` present on inbound events, the rule generalizes — and the routing unit is the **publish intent, not the run**:

* Each publish intent carries a target `resourceUri`; the owning adapter (matched by the URI's `provider` segment) interprets the `kind`/`locator` to hit the right provider API. A question asked on a PR review thread is answered on that thread; a comment on the issue is answered on the issue; a Slack message is answered in its thread.
* The default target is the `resourceUri` of the event that triggered the run, so the common single-trigger case needs no extra machinery.
* **Multiple surfaces pending → one run, multiple intents.** A work item has one stage machine, so accumulated activity on several surfaces (a Slack comment *and* an issue comment since the last run) is drained by a single run — which is also what full-context resumption wants, since the pending items may be related or contradictory and only one agent seeing both can reconcile them. The prompt presents pending activity grouped by surface with a stable per-item reference; the agent's replies cite the reference of the item they answer; Wake maps each reference back to its `resourceUri` and routes each intent independently, validating every target against the registry.
* Wake owns this routing end-to-end; the agent's publish intents never name a channel or provider — they name the conversation item being answered.

### 7. Echo suppression generalizes (#54 alignment)

Every outbound delivery already returns provider identifiers; under this decision those are recorded *per resource URI*. Suppression becomes one uniform rule — "drop inbound events whose provider ID matches a recorded outbound delivery on the same `resourceUri`, with the hidden marker as crash-recovery fallback" — instead of a per-surface mechanism, which is precisely the doubling #54 warned about.

### 8. Context delivery is a separate axis from correlation

The registry decides *what belongs to a work item*; it deliberately does not decide *how a resource's content reaches the agent*. Prompt/session assembly consumes `correlatedResources[]` as an inventory and chooses a **delivery mode** per resource, based on its `role`/kind and size:

| Mode | What the agent sees | Suits |
|---|---|---|
| `inline` | content embedded in the prompt (today's behavior) | small conversational payloads: comments, review threads, issue bodies |
| `materialized` | files snapshotted into the workspace by the owning adapter; prompt carries paths | large content artifacts: Jira/Confluence pages, long specs, exports |
| `by-reference` | the resource URI plus access instructions; agent fetches with its own tools | resources the agent's tooling handles better live (huge, paginated, or frequently changing content) |

Rules that hold across all modes:

* Materialized snapshots are **cache, not state**: they live in the ephemeral workspace (not committed, not under `.wake/events`), are re-derivable from the provider at any time, and carry the source `resourceUri` + fetch timestamp so staleness is visible.
* The delivery mode is chosen at assembly time by configuration/adapter defaults — it is *not* stored on the registration, because the right mode can change with resource size and task stage while the correlation itself is stable.
* **Reads may bypass Wake; writes must not.** Whatever mode is used to read, the agent's replies (e.g. answering a page comment) remain publish intents delivered through Wake's sink routing — otherwise the reply bypasses echo suppression and the durable event record, and Wake would later ingest its own agent's comment as fresh human input. The only sanctioned direct-write path is artifact creation with structured reporting (flow 2 in §3).

Correlation is what makes every mode workable: the registry is the enumerable inventory that assembly iterates over, and the `resourceUri` is simultaneously the routing key, the materialization source, and the by-reference pointer.

## Consequences

### Positive

* One mechanism serves #82 (PR activity) and every subsequent surface (Slack, Jira, Linear, GitLab); new integrations add an adapter and a URI grammar, not core schema changes.
* Correlation is durable, replayable, and rebuildable from `events/` — consistent with the event-first invariant; `state/` remains disposable.
* `correlatedResources[]` gives Wake the complete surface inventory of a work item, so prompts and resumed sessions can be assembled with full context no matter which surface triggered the run — the consolidation that makes resume-from-anywhere possible.
* Non-1:1 realities (multiple PRs or threads per issue, one PR touching two issues) are represented explicitly via roles and the primary/secondary relation instead of being ruled out or handled ambiguously.
* The agent's role stays bounded: it reports artifacts in structured output; it never routes, registers, or chooses channels. Verification-before-registration keeps agent claims out of the trust path.
* Watchlists make activity polling cheap and rate-limit friendly, and keep the fake adapters able to exercise the full contract at zero token cost.
* Routing and echo suppression stop being per-surface special cases.

### Negative

* New moving parts: one event type (plus retraction), a projection fold, a reverse index, a resolver step, and a `WorkSource` signature extension — fakes and real adapters must change together.
* The runner result contract grows an `artifacts` section; all runner adapters (Claude, Codex, Cursor, fake) must parse/emit it symmetrically.
* Artifact verification adds a provider round-trip per agent-reported artifact.
* Cross-provider correlation (Jira issue ↔ GitHub PR) requires the GitHub activity source to be configured for repos it would not otherwise know about; watchlist derivation must handle providers with zero originating tickets.
* The work-ID identity model requires a one-time fresh start of `.wake/` (existing data backed up, not migrated); in-flight items lose local attempt history. See the [implementation plan](../plans/2026-07-12-work-graph-implementation-plan.md).

### Neutral / deferred

* Slack, Jira, Linear, GitLab adapters themselves are out of scope; they must conform to this ADR when introduced (each should record its URI grammar and creation-flow choice in its own ADR or design doc).
* Whether Wake ever takes over PR creation from the agent (flow 1 for PRs) is left open; both flows conform, so the choice can be revisited per adapter without touching this decision.
* Shared resources are supported via the primary/secondary relation, but no policy behavior beyond context-only fan-out is defined for secondaries yet (e.g. auto-closing a secondary issue when a shared PR merges is deliberately not decided here).
* Context-delivery mode *selection* is scoped out: whether it is per-adapter config, a size threshold, a `role` default, or a per-stage choice needs its own design once a large-content adapter (Jira/Confluence) is real. This ADR fixes only the mode vocabulary and the read/write asymmetry.
* Credential provisioning for `by-reference` fetches (how an agent workspace gets read access to a provider without inheriting Wake's write credentials) is deliberately unresolved — it is a sandbox/security decision, not a correlation one.
* Whether materialization is a `WorkspaceManager` responsibility or a new seam alongside it is left to the first implementing adapter.
* **Work-to-work relationships** (depends-on, blocked-by, follow-up, split, supersedes — the handoff's work-topology layer) are deferred. When introduced they should reuse this event family — a registration whose target URI names another work item — rather than a parallel linking mechanism; the `role` vocabulary grows, the event shape does not. Nothing is decided about their policy effects (e.g. unblocking on dependency close) here.
* **A richer graph projection** (nodes/edges store, multi-hop queries, Quorum software-graph linkage) is deferred. `correlatedResources[]` plus the reverse index are the only read models this ADR requires; anything more is a future rebuildable projection over the same events.

## Confirmation

Implementation of #82 confirms this decision when:

1. An agent-created PR is registered via the structured `artifacts` path and appears in `correlatedResources[]` with `provenance: agent-reported` after provider verification.
2. Deleting `state/` and replaying `events/` reproduces the registry and reverse index exactly.
3. A human comment on the PR conversation, and separately on a review thread, each resume the *issue's* lifecycle and receive replies on the surface they were made on.
4. A PR opened out-of-band with the branch-name convention (or hidden marker) is recovered by detection with `provenance: detected`, or adoptable via operator declaration.
5. Wake's own PR comments are suppressed by the per-`resourceUri` echo rule without any PR-specific suppression code.

## More Information

* `docs/architecture.md` — event-first flow this builds on.
* [`docs/handoffs/wake-work-graph-handoff.md`](../handoffs/wake-work-graph-handoff.md) — the work-graph concept this registry is the first layer of.
* [`docs/handoffs/2026-07-12-resource-correlation-implementation.md`](../handoffs/2026-07-12-resource-correlation-implementation.md) — condensed implementation invariants for this ADR.
* [`docs/plans/2026-07-12-work-graph-implementation-plan.md`](../plans/2026-07-12-work-graph-implementation-plan.md) — now-vs-later sequencing, identity cutover, and scope guard.
* Related issues: [#54](https://github.com/atolis-hq/wake/issues/54) echo suppression (prerequisite), [#76](https://github.com/atolis-hq/wake/issues/76) PR exclusion → policy engine (prerequisite), [#70](https://github.com/atolis-hq/wake/issues/70) sink router (routing substrate), [#82](https://github.com/atolis-hq/wake/issues/82) first consumer of this decision.
* MADR template: https://adr.github.io/madr/
