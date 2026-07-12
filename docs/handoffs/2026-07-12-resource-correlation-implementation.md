# Implementation handoff: resource correlation (ADR 0001)

Implements [ADR 0001](../adrs/0001-correlating-external-resources-to-work-items.md) — read it first; this doc is the condensed "get these right" list, not a replacement. First consumer is issue #82 (PR activity source). Prerequisites that must land first: #54 (unified echo suppression) and #76 (PR exclusion moves from the GitHub client into policy-engine — `policy.isEligible()` still rejects `issue.issue.isPullRequest` today).

## Non-negotiable invariants

1. **The registry is events, not state.** Correlation lives in `wake.correlation.registered` / `wake.correlation.retracted` envelopes under `events/`; `correlatedResources[]` on the projection and the reverse index (`resourceUri → workItemKey`) are folds over those events. Deleting `state/` and replaying `events/` must reproduce both exactly. Never persist correlation only in the projection, and never cache it in process memory between ticks.
2. **Core resolves; adapters never touch the registry.** Sources return events carrying `sourceRefs.resourceUri` with *no* obligation to know the work item. A resolver step in `tick-runner.ts` (between `pollEvents()` and `appendEventEnvelope`, currently ~line 567) stamps the canonical `workItemKey`. Do not give any adapter read access to core state — watchlists are handed to sources as plain data arguments, not fetched by them.
3. **One primary per resource URI.** The fold enforces it: a second `primary` registration on a claimed URI is downgraded to `secondary` and a warning event is appended. Promotion requires an explicit retraction of the incumbent first. Silent re-mapping moves conversation history between work items — treat it as corruption, not a merge.
4. **Secondaries never wake a lifecycle.** Activity on a shared resource resumes only the primary item; copies appended to secondary items' streams must carry `trigger: 'context-only'`.
5. **Agent-reported artifacts are verified before registration.** The runner-result `artifacts` block is parsed exactly like sentinels (`domain/schema.ts`). Before emitting the registration event, the owning adapter must resolve the claimed URL to a live resource and check its head branch matches the run's workspace branch. An unverifiable claim is a malformed result — do not register, do not trust, surface it like a bad sentinel.
6. **Reads may bypass Wake; writes must not.** Whatever context-delivery mode is used, agent replies are always publish intents through the sink router. The only sanctioned direct write is artifact creation + structured report (invariant 5). If an agent writes to a surface directly, echo suppression and the durable record are broken.
7. **The publish intent is the routing unit, not the run.** Multiple surfaces with pending activity → one run draining all of them, emitting one intent per reply. Default target = the triggering event's `resourceUri`; the agent cites the per-item reference from the prompt, never a channel/provider name; Wake validates every intent target against the registry before delivery.
8. **Unresolvable events are never dropped.** An event whose `resourceUri` has no registry entry (e.g. a detection hint on an unknown PR) is appended under `streamScope: 'global-intake'` — visible, replayable, adoptable later via operator declaration.

## Seam changes (fakes and reals move together)

- `WorkSource.pollEvents()` gains a watchlist argument (e.g. `pollEvents({ watch: ResourceRef[] })`). Update `fake-ticketing-system.ts` and `github-issues-work-source.ts` symmetrically; the fake must genuinely exercise watch-driven polling, not ignore the argument.
- PR activity is a **separate adapter** (`createGitHubPullRequestActivitySource`), sharing `github-client` with the issues source but implementing its own `WorkSource`. Do not fold PR behavior into the issues source — the issue source is a *discovery* source (mints work items, self-keys); activity sources poll only watched resources.
- `AgentRunResult` gains the structured `artifacts` section. All runners must change together: `claude-runner`, Codex, Cursor, and `fake-runner`. The fake must emit parseable artifacts so `tick` tests exercise the full verify-and-register path at zero token cost.
- Sink routing extends `sink-router.ts`'s existing `sourceRefs.sink` mechanism to `resourceUri` targets; the owning adapter is matched by the URI's `provider` segment.
- Any new runner invocation must set `--max-turns` and a wall-clock timeout; a failed run surfaces as `BLOCKED`, never retry-with-bigger-model.

## URI and naming rules

- Grammar: `<provider>:<kind>:<locator>`. `provider` must equal the adapter's registered source/sink name. `kind` uses the provider's native vocabulary (`github:pr:…` but `gitlab:mr:…`). Core compares URIs for equality only — never parse a `locator` outside its owning adapter.
- `workItemKey` shape is untouched. Existing keys, projections, and state files must load unchanged (the schema preprocessors in `domain/schema.ts` handle legacy records — don't break them).
- `sourceRefs` gains one optional field, `resourceUri`. It stays per-event provenance; item-level ownership lives only in the registry.

## Detection (build second, not first)

Contract flows (Wake-created, agent-reported, operator-declared) are the mechanism; detection is recovery. Wake-influenced PR bodies get `<!-- wake:work-item <key> -->`; the branch-name convention from `git-workspace-manager` already identifies the work item from a PR's head branch. `Closes #N` links are hints that surface a *proposed* correlation — never auto-register from them. Everything detection finds goes through the same event with `provenance: 'detected'`.

## Echo suppression interplay (#54)

Record provider IDs of outbound deliveries **per `resourceUri`**. Suppression is then one rule everywhere: drop inbound events whose provider ID matches a recorded delivery on the same URI, with the hidden marker as crash-recovery fallback. If you find yourself writing PR-specific or Slack-specific suppression code, the design has been violated.

## Acceptance (mirrors ADR §Confirmation)

1. Agent-created PR → registered via `artifacts` path with `provenance: 'agent-reported'` only after provider verification.
2. `rm -rf state/` + replay reproduces registry and reverse index exactly.
3. A PR-conversation comment and a review-thread comment each resume the *issue's* lifecycle and are answered on their own surface.
4. Out-of-band PR recovered by branch-name/marker detection, or adoptable via operator declaration.
5. Wake's own PR comments suppressed by the per-URI rule with zero PR-specific suppression code.
6. Slack comment + issue comment pending together → one run, two publish intents, each delivered to its own surface.
7. `npm run verify` passes; if the CLI/config surface changed (e.g. an operator `wake correlate` command or new source config), `README.md` / `docs/configuration.md` are updated in the same change.
