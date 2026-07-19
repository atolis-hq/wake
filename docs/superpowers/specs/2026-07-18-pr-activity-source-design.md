# PR activity source: design

- Date: 2026-07-18
- Status: proposed
- Implements: [Issue #82](https://github.com/atolis-hq/wake/issues/82), [work graph implementation plan](../../plans/2026-07-12-work-graph-implementation-plan.md) §3 ("Correlation core, bundled with #82")
- Governed by: [ADR 0001](../../adrs/0001-correlating-external-resources-to-work-items.md)
- Builds on: [work identity and correlation vocabulary design](2026-07-16-work-identity-correlation-design.md) (identity cutover, landed in #235)

## Purpose

Let PR comments and reviews resume the issue's lifecycle the same way issue comments already do, with replies routed back to whichever surface (issue, PR conversation, or a specific review thread) triggered them. Per #82's review thread, this must be a separately defined source adapter — not the issues source extended with PR-specific behavior — and the two must not overlap in what they emit.

## Prerequisites (already met)

- #54 (unified echo suppression) — CLOSED
- #76 (PR exclusion moved to policy engine) — CLOSED
- Work identity + correlation registry (#235) — landed; `correlatedResources[]`, the reverse index, and the central resolver already exist.

## Governing decisions

### D1'. Minting becomes qualification-gated (supersedes identity design D1)

The identity design states "a miss means mint; there is no other trigger." That was correct for a single discovery source (GitHub issues) where every polled item is by construction something a human wants worked. It does not hold once a second source can produce unresolved events: an arbitrary PR comment on a PR nobody asked Wake to touch must not silently become a new unit of work.

**Resolved:** minting is gated by a per-source qualification policy, not a hardcoded discovery-vs-activity split. Any source's unresolved event may mint, but only if it satisfies that source's configured qualification (mirroring the existing `sources.github.policy.{requiredLabels,requiredAssignees}` shape for issues). A resource that already resolves through the registry — i.e. it's correlated to existing work — never re-checks policy; the gate applies only to the mint decision on a miss.

For the PR activity source specifically, qualification is **author-based**, not label-based: a PR is workable as its own item only if opened by a configured author (e.g. a human on an allowlist), because PRs don't carry Wake's issue-label workflow and a PR's own labels are typically GitHub's review-status labels, not intent signals. Config shape:

```jsonc
"sources": {
  "github": {
    "pullRequests": {
      "enabled": false,
      "policy": {
        "requiredAuthors": []   // empty = accept none (safe default); PRs only ever resume via existing correlation until configured
      }
    }
  }
}
```

An unresolved PR event that fails qualification is **not dropped**: it is appended under `streamScope: global-intake` (ADR 0001 §5), recoverable later via `wake correlate`.

### D2. The issues source stops emitting PRs

GitHub's issues-list API returns PRs interleaved with issues (`pull_request !== undefined`). Today `github-issues-work-source.ts` maps this to `isPullRequest: true` and lets `policy-engine.ts` reject it downstream. That coupling is exactly what #82's review flagged.

**Resolved:** `github-issues-work-source.ts` filters out `pull_request !== undefined` items at poll time — they are never emitted as unkeyed events by this source, full stop. All PR-shaped events come from the new `createGitHubPullRequestActivitySource` adapter. `policy-engine.ts`'s `isPullRequest` rejection becomes dead code for the issues path and is removed; the new source's own qualification (D1') is the only PR-admission gate.

### D3. No new resume-decision logic

Today's rule — resume the CLI session if `projection.wake.sessionId` exists, else start fresh — already generalizes: a PR comment or review is just another trigger against the same work item, so it inherits the same session and workspace an issue-comment retry would. Resume-mode prompting already tells the agent not to make changes solely because it was asked a question (`stage-prompt.ts`), which covers #82's "could just be a question" case without new mechanism. **No change needed here beyond feeding PR activity into the same trigger path (D5).**

### D4. PR-comment context delivery is `inline`, with anchoring, not materialization

PR conversation comments and reviews are small and conversational — `inline` delivery (ADR 0001 §8) applies exactly as it does for issue comments. Review-thread comments carry `path`/`line`/`diff_hunk` from GitHub; Wake passes the file/line reference inline in the prompt rather than embedding the diff, because the resumed agent already has a live workspace checked out on the PR's branch and can read the real file. No new content-delivery mode is introduced.

### D5. Pending activity generalizes across surfaces via `comments[]`

`policy-engine.ts`'s retry trigger (`latestUnhandledHumanComment` / `chooseRetryActionAfterHumanReply`) scans `IssueStateRecord.comments[]`, which today only ever holds issue-thread comments. PR conversation comments and review comments fold into the **same** `comments[]` array rather than a parallel list:

- `commentSnapshotSchema` gains an optional `resourceUri` (which correlated surface this comment came from; absent = issue thread, keeping today's shape valid) and an optional `reviewThread` object (`{ path: string; line?: number }`) for review-thread anchoring.
- `comments[]` becomes "unified pending conversation across every correlated surface, in provider timestamp order." The existing bot/human split and last-bot-index windowing keep working unmodified — they already operate on the array element shape, not on which surface it came from.
- The resume prompt renders each pending item with its surface and (if present) file/line, and the agent's structured reply cites which item it's answering (ADR 0001 §6); Wake maps that citation back to a `resourceUri` for routing.

This was the one schema fork worth naming explicitly: a parallel `activity[]` array was considered and rejected because it would duplicate the retry-trigger scan and force the prompt to merge two lists back into one chronological view — the thing `comments[]` already is.

## Design

### 1. Runner artifact reporting (agent → Wake: "I made this PR")

`domain/schema.ts` gains a structured `artifacts` block, parsed the same way as the `wake-result` sentinel fence:

````
```wake-artifacts
{ "artifacts": [{ "kind": "pr", "url": "https://github.com/org/repo/pull/91" }] }
````

```

* Parsed by a new `parseRunnerArtifacts()` alongside `parseRunnerResult()`.
* `tick-runner.ts` verifies each reported artifact against the provider before registering it: for `kind: "pr"`, the GitHub adapter resolves the URL to a live PR and checks its head branch matches the run's workspace branch (the same deterministic branch convention D2 of the identity design already relies on). An unverifiable claim is treated like a malformed sentinel — logged, not registered, and does not fail the run.
* A verified artifact is registered via the existing `wake.correlation.registered` event (`role: implementation`, `relation: primary`, `provenance: agent-reported`, `registeredBy: <runId>`).
* All runner adapters (Claude, Codex, Cursor, fake) must emit/parse this symmetrically — the fake runner needs a way for tests to script an artifact report.

### 2. Mint qualification (D1')

* `policy-engine.ts` gains a source-agnostic `qualifiesForMint(unresolvedEvent, config)` used only by the resolver's miss path — never by the existing "is this projection eligible for the next action" check, which stays as-is.
* For `github:issue:…` resources this reduces to today's `requiredLabels`/`requiredAssignees` check (no behavior change for issues — issues still mint the same way they do today).
* For `github:pr:…` resources it checks `sources.github.pullRequests.policy.requiredAuthors` against the PR's author.
* `resolveInboundEvent` in `tick-runner.ts` changes: on a registry miss, call `qualifiesForMint`. If it passes, mint as today. If it fails, append the event under `streamScope: global-intake` instead of minting — visible and replayable, never silently dropped.

### 3. GitHub PR activity source

New `src/adapters/github/github-pull-request-activity-source.ts` implementing `WorkSource`:

* Polls, per watched PR (see §4): PR conversation comments (issue-comments API against the PR number), reviews (pulls-reviews API), and review-thread comments (pulls-review-comments API).
* Emits unkeyed events with `sourceRefs.resourceUri` set to `github:pr:<repo>#<n>` (conversation/review) or `github:pr-review-thread:<repo>#<n>/<threadId>` (a specific review comment thread — GitHub review comments carry `in_reply_to_id`/thread grouping that the adapter derives a stable thread id from).
* Shares `github-client.ts` and `github-auth.ts` with the issues source for the HTTP/auth plumbing, but is registered and wired in `main.ts`'s `buildRuntime` as its own named source, fanned in via `createWorkSourceFanIn` alongside (not merged into) the issues source.
* A symmetric `fake-github-pull-request-activity-source.ts` (or an extension of the existing fake ticketing system) lets tests script PR comments/reviews at zero token cost.

### 4. Watchlist plumbing

* `WorkSource.pollEvents()` gains an optional `{ watch: ResourceRef[] }` argument (ADR 0001 §5, C3). The issues source ignores it (it's a discovery source polling by repo config, not by watchlist). The PR activity source **requires** it — it has no other way to know which PRs to poll.
* `tick-runner.ts` derives the watchlist before polling: every `correlatedResources[]` entry across open work items whose `resourceUri` starts with `github:pr:` or `github:pr-review-thread:`, deduplicated to the owning PR.
* This keeps PR polling bounded to PRs Wake actually knows about (registered via §1, or previously adopted via `wake correlate`) instead of scanning every PR in every configured repo.

### 5. Reply routing generalization

* `sink-router.ts` currently targets sinks by `sourceRefs.sink` / `payload.origin` (the source name). It gains a second targeting path: when a publish intent's underlying event carries `sourceRefs.resourceUri`, the GitHub sink resolves that URI's `provider`/`kind` to decide *where on GitHub* to post — the issue thread, the PR conversation, or a specific review comment thread (via the review-comment reply API) — rather than always posting to the issue.
* Default target stays "the `resourceUri` of the triggering event," so the common single-trigger case needs no extra machinery, per ADR §6.
* Multi-surface fan-out (one run answering several pending items on different surfaces, each cited separately per D5) is **in scope for this phase** since it falls out of the same per-item `resourceUri` once §1's citation mapping exists — it is not deferred to a later pass.
* Echo suppression (#54) already records provider IDs per outbound delivery; confirm (with a test) that PR conversation and review-thread deliveries suppress correctly with zero PR-specific code, per ADR §7.

### 6. Prompt context

* The resume prompt's comment-rendering section (already generalized for surfaces per D5) additionally renders `reviewThread.path`/`line` when present, framed as "review comment on `<path>:<line>`" so the agent knows to look at that file in its already-checked-out workspace.
* No diff/materialization is added (D4).

## Implementation sequencing

Each phase lands independently and is tested via the fakes before the next starts:

1. **Artifact reporting** (§1) — runner contract + verification + registration. No PR source needed yet; testable today by having the fake runner report an artifact against an existing fake PR.
2. **Mint qualification** (§2) — resolver + policy change. Testable with a fake unresolved event and a policy config, independent of §1/§3.
3. **Issues-source PR filtering** (D2) — one-line filter + test asserting PRs never appear in `github-issues-work-source`'s output.
4. **Watchlist plumbing** (§4) — `pollEvents({ watch })` contract change across `WorkSource`, both fakes, and the issues source (which ignores it).
5. **GitHub PR activity source** (§3) — the new adapter, wired behind config, `enabled: false` by default.
6. **Comments/activity schema generalization** (D5) — `commentSnapshotSchema` fields, projection fold, retry-trigger scan.
7. **Reply routing** (§5) — sink-router resourceUri targeting, review-thread reply API, echo-suppression confirmation test.
8. **Prompt context + end-to-end test** (§6) — anchoring in the resume prompt, and a full fake-adapter scenario: issue → implement → PR artifact reported & verified → PR review comment polled via watchlist → resume → reply lands on the specific review thread.

Docs to update alongside implementation: `README.md` (new `sources.github.pullRequests` config), `docs/configuration.md`, `docs/architecture.md` (mention the second source and its watchlist dependency).

## Consequences

### Positive

* PRs and issues stay fully decoupled at the source level — no shared filtering logic, no shadow `isPullRequest` branching in policy.
* Mint qualification generalizes cleanly to future sources (Slack, Jira) without a hardcoded source-category distinction.
* No new session-management or content-delivery mechanism — both reuse what already exists, keeping the blast radius to the genuinely new surfaces.

### Negative / deferred

* `sources.github.pullRequests.policy.requiredAuthors` defaulting to empty means standalone PR adoption is opt-in and requires explicit config — acceptable since the primary use case (PR opened by Wake's own agent from an issue) never depends on it; only human-initiated standalone PRs need it configured.
* Detection/marker recovery for out-of-band PRs (ADR §4) is not built here — `wake correlate` remains the manual escape hatch. Automated detection scanning stays deferred per the work-graph implementation plan.
* Slack/Jira adapters are unaffected and out of scope, as before.
```
