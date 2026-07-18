# Wake — Simplify / Solidify / Refactor Report

**Date:** 2026-07-10
**Scope:** full review of `src/` (~6,400 lines TS) and supporting tests.
**Purpose:** a menu of improvements that can be selected individually and broken into backlog items. Each item states the problem, evidence, proposed change, and a rough size (S/M/L). Items are independent unless noted.

Priorities at a glance:

| # | Item | Type | Size | Impact |
|---|------|------|------|--------|
| E1 | Closed issues never observed; workspace cleanup unreachable | Solidify | M | Critical — closed-issue path is dead code; workspaces leak |
| E2 | Unguarded workspace cleanup can brick every tick | Solidify | S | Critical — one locked dir halts the whole control plane |
| E5 | No outbound delivery guarantee (lost BLOCKED questions) | Solidify | M | High — dead-lettered intents stall issues invisibly |
| S1 | Scope the tick-runner try/catch; stop overwriting completed runs | Solidify | M | High — durable-record corruption |
| R1 | Unify the three CLI runner adapters | Simplify | L | High — removes ~700 duplicated lines |
| R8 | Normalize runner result parsing / usage metadata | Solidify | M | High — 35% of logged runs hit degraded parsing; cost/usage dropped |
| E13 | Quota backoff via the dead `pausedUntil` ledger | Solidify | S–M | High — observed 429 retry/comment-spam loop in production |
| E14 | FAILED runs strand refine-stage items with no exit | Solidify | S–M | High — failed refines are unrecoverable via comments |
| S2 | Robust `/approved` parsing + explicit rejection handling | Solidify | S | High — approval gate integrity |
| S3 | Migrate legacy `blockedFromAction` context key | Solidify | S | High — blocked issues silently never retry |
| S8 | Incremental GitHub polling; remove dead `lookbackMs` | Solidify | M | Medium — rate-limit exposure |
| R2 | Decompose tick-runner; move display formatting out of events | Simplify | M | Medium |
| I3 | Stage machine as a single declarative table | Refactor | M | Medium — enables new stages cheaply |

---

## A. Solidify — correctness and robustness

### S1. Over-broad try/catch in the tick runner corrupts durable records on outbound failure

**Problem.** In `src/core/tick-runner.ts` a single `try` block (starting ~line 477) covers workspace preparation, the runner invocation, the run-record write, the `wake.run.completed` event append, **and** the outbound deliveries (labels + publish intent). If an outbound delivery throws — e.g. a GitHub 5xx while posting the status comment — the `catch` block:

1. **Overwrites the already-written completed run record as `failed`** (`writeRunRecord` at ~line 613 with `status: 'failed'`), destroying an accurate durable record of a successful agent run.
2. **Appends a second event with the same `eventId`** — both paths use `` `${runId}-completed` `` (lines ~543 and ~625) — putting a duplicate ID in the append-only log and folding a contradictory `FAILED` result over the projection.
3. Publishes a failure comment for a run that actually succeeded, potentially after the real work (a PR) already landed.

**Proposed change.** Narrow the `try` to workspace prep + `runner.run` + result parsing. Once the completed run record and `wake.run.completed` event are written, subsequent outbound failures should be recorded as their own delivery-failure event (e.g. `wake.publish.failed`) without rewriting the run outcome. This also gives you a natural retry point: undelivered intents can be re-attempted on the next tick (the event log already tells you what was and wasn't delivered).

**Size:** M. Touches only `tick-runner.ts` plus tests, but the state transitions need careful test coverage (delivery-failure-after-success is currently untested).

### S2. Approval detection is a substring match; any other comment silently re-runs the pending action

**Problem.** `src/core/policy-engine.ts:161` — `latestHumanComment.body.includes('/approved')`. Two issues:

- Substring matching: a comment like "I have *not* /approved this yet" or a quoted reply containing `/approved` approves the gate.
- The rejection path is implicit: **any** non-approving human comment while `awaiting-approval` causes the pending action to be fully re-run with the comment as feedback. A human asking a clarifying question ("what does this change do?") triggers a complete implement re-run.

**Proposed change.** Parse commands as a token at the start of a line (e.g. `^/approved\b` on any line, trimmed). Introduce an explicit rejection/changes command (e.g. `/changes <feedback>`), and treat non-command comments while awaiting approval as conversation — either post a reply via a cheap resume, or simply hold state and let the human be explicit. At minimum, document the current behaviour and tighten the regex.

**Size:** S for the regex + tests; M if adding a distinct question/conversation path.

### S3. Legacy `blockedFromAction` context key means old blocked issues never retry

**Problem.** `chooseRetryActionAfterHumanReply` (policy-engine.ts:128) reads `context.lastRunAction`. State files written by older versions carry `blockedFromAction` instead, so for those issues the function returns `null` forever: a human reply to a blocked issue is silently ignored. (Verify against real `.wake/state/` files before implementing.)

**Proposed change.** The `issueStateRecordSchema` preprocess step in `src/domain/schema.ts` already normalizes legacy stages (`normalizeLegacyStage`); add context-key normalization there (`blockedFromAction` → `lastRunAction` when the latter is absent). This pairs naturally with R5 (typed context).

**Size:** S.

### S4. `Infinity` timeout when only fake runners are configured

**Problem.** `maxConfiguredRunnerTimeoutMs` (`src/domain/runner-routing.ts:20`) returns `Infinity` when no real runner is active. That value feeds:

- the tick lock's `staleAfterMs` — age-based stale detection never fires (the PID-liveness check masks this on the same host, but PID reuse or a lock file surviving a host move deadlocks ticks);
- `isStaleRunningRecord` — run records stuck in `running` are never reconciled in fake-only configs, which is exactly the config used by tests and `npm run tick` demos.

**Proposed change.** Clamp to a finite default (e.g. the schema's 30-minute default) when no real runner contributes a timeout.

**Size:** S.

### S5. State store swallows all read errors as "missing"

**Problem.** `src/adapters/fs/state-store.ts` catches everything and returns `null`/`[]` (`readIssueState`, `readLedger`, `listIssueStates`, etc.). A corrupt or schema-invalid projection file is indistinguishable from an absent one. Consequences: `listIssueStates` silently drops a work item (Wake forgets it exists); `readIssueState` returning `null` during polling makes the work source re-ingest the issue as brand new.

**Proposed change.** Distinguish `ENOENT` (legitimately missing) from parse/validation failures. For the latter, at minimum log a warning with the file path; better, append an internal `wake.state.corrupt` event so the problem is visible in the durable record. Since `state/` is a rebuildable projection, corruption should trigger (or at least suggest) a rebuild rather than silence — see I6.

**Size:** S–M.

### S6. Ambiguous stage labels resolve silently

**Problem.** `stageFromLabels` (`src/domain/stages.ts:42`) returns `undefined` when an issue carries two different `wake:stage.*` labels (e.g. a human added one without removing the other). The projection then keeps its old stage — or defaults to `queue` for a new issue — with no signal that reconciliation was skipped.

**Proposed change.** When multiple stage labels are present, surface it: log and/or emit an internal conflict event, and consider preferring the most-advanced stage or the label matching local history. The current "single label wins, otherwise ignore" rule is reasonable; the gap is only that it's invisible.

**Size:** S.

### S7. Codex session resume is silently unsupported; dead resume code

**Problem.** `codex-runner.ts` hardcodes `runMode = 'start'` (line 225) and never inspects `projection.wake.sessionId`, while Claude and Cursor runners resume blocked sessions after a human reply. The blocked→reply→retry flow silently loses the whole session context on Codex. Meanwhile `buildCodexResumeArgs` (line 67) and `buildCursorResumeArgs` (cursor-runner.ts:66) are exported but never used by the runners — dead code that implies capability that isn't wired.

**Proposed change.** Either implement resume for Codex (`codex exec resume <id>`, keeping the header comment honest), or delete the unused builders and state the gap in the parity comment + `docs/runner-comparison.md`. Folding into R1 makes this cheap: resume support becomes a per-CLI capability flag in one place.

**Size:** S (document/delete) or M (implement resume).

### S8. GitHub polling is full-scan every tick; `lookbackMs` is dead config

**Problem.** `github-issues-work-source.ts` lists up to `maxIssuesPerRepo` issues **and then lists comments for every issue** on every tick, regardless of change. No `since` parameter, no conditional requests. API cost per tick is `repos × (1 + issues)` calls; at the default 60s interval this eats rate limit quickly as repos/issues grow. Separately, `sources.github.polling.lookbackMs` is defined in the config schema (schema.ts:308) and documented, but never read by any code.

**Proposed change.** Use `since=<last successful poll − small overlap>` on both the issues and comments endpoints (this is where `lookbackMs` becomes real — the overlap window), and skip the comments call when the issue's `updated_at` hasn't moved. `sourceStateRecord.lastSuccessfulPollAt` already exists to carry the cursor. If not implementing soon, delete `lookbackMs` from schema and docs (per the documentation rule, config surface and docs must match).

**Size:** M.

### S9. Infra failures consume the triggering human comment, stalling the issue

**Problem.** In the tick-runner catch path, the failure event records `handledCommentId: latestHumanCommentId(candidate)` (line ~644). After projection fold: the human comment is marked handled **and** `lastRunSentinel = FAILED`, so `needsWakeAction` returns false. A transient infra blip (CLI crash, timeout) therefore permanently stalls the issue until a human posts *another* comment — the retry the human already asked for is eaten.

**Proposed change.** Only mark the comment handled when the run reached the agent and produced a real outcome (DONE/BLOCKED/AWAITING_APPROVAL, or an agent-level FAILED). For `failureClass: 'infra'`, leave `handledCommentId` untouched so the next tick retries. Pairs with I2 (attempt counter) to avoid a tight retry loop on persistent infra failure.

**Size:** S–M.

### S10. Fixed candidate ordering can starve work items

**Problem.** `runTick` processes exactly one candidate per tick, always the first eligible in `workItemKey` sort order (`listIssueStates` sorts lexicographically). A repo/issue with a low sort key that repeatedly needs action delays everything behind it indefinitely.

**Proposed change.** Order candidates by least-recently-acted (e.g. oldest `wake.syncedAt` or last run time) instead of key order. Still deterministic given durable state, so the "tick is a pure function of durable state" invariant holds.

**Size:** S.

### S11. Failure classification by stderr substring is fragile

**Problem.** `classifyClaudeCliFailure` / `classifyCursorCliFailure` grep combined stdout+stderr for words like `authentication`, `permission denied`, `quota`. Agent output that legitimately *mentions* those words (e.g. a run about fixing an auth bug) misclassifies as `quota`. Impact is low today (failureClass is informational), but it will bite when routing/backoff decisions start keying off it.

**Proposed change.** Prefer structured signals where available (exit codes, JSON error fields in CLI output) and only fall back to substring heuristics on stderr alone, not stdout. Centralize in the shared runner core (R1).

**Size:** S (as part of R1).

---

## B. Simplify — duplication and structure

### R1. Unify the three CLI runner adapters behind one runner core

**Problem.** `claude-runner.ts` (480), `codex-runner.ts` (385), `cursor-runner.ts` (415) are ~60–70% identical, and the duplication has already caused drift:

- `formatClaudeRunLogLine` / `formatCodexRunLogLine` / `formatCursorRunLogLine` — byte-identical except the tag.
- `resolveModel`, `readSandboxLogBreadcrumb`, `compactLogValue` — three identical copies each.
- Failure-result assembly (timeout message / no-output / stderr / breadcrumb / `FAILED` trailer) — three near-copies; Codex's copy is missing `failureClass` entirely, and only Cursor guards result-parsing with try/catch.
- `smoke()` return shape — three copies.

**Proposed change.** One `createCliRunner(strategy)` in `adapters/runner/` handling: session-resume decision, stage prompt build, logging, spawn with timeout, common failure envelope, sandbox breadcrumb, metadata assembly, smoke shape. Per-CLI strategy supplies only what genuinely differs: `cliName`, `buildArgs(start|resume|smoke)`, `parseOutput(stdout)`, `classifyFailure`, optional `toolCapabilityNote`, capability flags (supportsResume, supportsMaxTurns, supportsAllowedTools). Keeps `core/contracts.ts` untouched; the fake runner is unaffected. Expected net deletion of ~600–700 lines, and future CLIs (Gemini, etc.) become ~100-line strategies. Fix S7 and S11 in passing.

**Size:** L (mechanical but wide; the three existing runner test suites become the safety net — convert them to run against the unified core with each strategy).

### R2. Decompose the tick runner; keep durable events free of display formatting

**Problem.** `tick-runner.ts` is 691 lines mixing five concerns: locking, stale-run reconciliation, candidate selection, the approval transition, run execution, and event construction — plus **presentation** helpers (`formatDuration`, `formatTokenCount`, `statusLabelForStage`). Event payloads store pre-formatted display strings (`duration: "3m12s"`, `tokens: "45k"`), so the durable record has lossy, sink-specific formatting baked in, and every ~30-line `createEventEnvelope` call restates the same envelope boilerplate.

**Proposed change.**

1. Extract a `core/run-events.ts` module of small factories (`runClaimedEvent`, `runCompletedEvent`, `labelsIntentEvent`, `publishIntentEvent`) that stamp the shared envelope fields once.
2. Store raw values in payloads (`durationMs`, `tokenCount` as numbers); move human formatting into the GitHub sink's `formatWakeComment`, which is already the presentation layer.
3. Extract `handleApprovalTransition(...)` and a shared `finishRun(...)` used by both the success and failure paths (they currently duplicate the run-record write + completed event + labels + publish-intent sequence).

**Size:** M. Do after/with S1 since both reshape the same function. Note: changing payload fields is an event-schema change — keep reading old string forms in the sink for existing logs, or accept that old events render slightly differently.

### R3. Collapse the runner-registry / runner-cli-adapter duplication

**Problem.** `runner-registry.ts` and `runner-cli-adapter.ts` both contain a kind-switch that constructs the same runners, and resume-command construction exists twice (`buildResumeCommand` per adapter branch **and** `buildResumeCommandForCli`). Adding a runner kind currently means editing 4+ switch sites (registry, cli-adapter, `buildResumeCommandForCli`, schema union).

**Proposed change.** A single descriptor table keyed by kind: `{ create(settings, cwd), cliName, resumeCommand(sessionId), smokeShape }`. Registry, cli-adapter, and the GitHub sink's resume-command rendering all read from it. With R1, the descriptor and the strategy can be the same object. Side benefit: `github-issues-work-source.ts` stops importing from `adapters/runner/` (an adapter→adapter dependency that currently couples the sink to runner internals).

**Size:** S–M.

### R4. Typed projection context instead of `as Record<string, unknown>` probing

**Problem.** `issue.context` is `Record<string, unknown>`; policy-engine (4 sites) and stage-prompt re-derive `lastHandledCommentId` / `lastRunAction` / `lastCompletedAction` / `lastRunSentinel` / `pendingApprovalAction` with inline `typeof` checks. Key-name typos compile fine (which is exactly how the S3 legacy-key problem stays invisible).

**Proposed change.** Add a `wakeContextSchema` (all fields optional, `.passthrough()` for forward-compat) to `schema.ts`, parsed as part of `issueStateRecordSchema`. Policy code then reads `issue.context.lastRunAction` type-safely. Legacy-key normalization (S3) lives in the same preprocess.

**Size:** S.

### R5. Make the action→claimed-stage mapping explicit

**Problem.** `const claimedStage = action as Stage` (tick-runner.ts:442) type-checks only because the two action names happen to also be stage names. Adding an action that isn't a stage breaks this silently at the cast.

**Proposed change.** `claimedStageForAction(action): Stage` in `domain/stages.ts` with an exhaustive switch. One honest function beats a lucky cast.

**Size:** S.

### R6. Deduplicate config defaults in the zod schema

**Problem.** `wakeConfigSchema` repeats every nested default in giant `.default({...})` literals (schema.ts:276, 285–290, 319–320), including five fully-spelled-out runner entries. Changing one default (e.g. `timeoutMs`) requires edits in several places, and they can drift from the per-field defaults.

**Proposed change.** Rely on per-field `.default()` propagation: define the entry schemas so `claudeRunnerEntrySchema.parse({kind:'claude'})` yields the full default entry, then build the top-level defaults by parsing minimal literals (or a `buildDefaultConfig()` helper) rather than restating every field.

**Size:** S.

### R7. Minor cleanups

- `resolveSmokEntry` → `resolveSmokeEntry` (main.ts:263).
- Stateless factories `createPolicyEngine` / `createLifecycleService` add a layer of indirection over what are pure functions; exporting the functions directly reads better (keep factories only where DI state exists, like `createProjectionUpdater`).
- `main.ts` inlines docker `spawn` helpers (`inspectDockerImage`, `inspectDockerContainer`) that belong next to `adapters/docker/docker-cli.ts`; the hand-rolled flag scanning could move to `node:util` `parseArgs` when the CLI surface next changes.
- `parseRunnerResult` computes `lines` twice (schema.ts:409–411).
- `appendEventEnvelope` writes every event twice (day-JSONL + per-event file). If the per-event file exists only to serve `listEventEnvelopesForWorkItem`, consider deriving that read path from the JSONL (or an index) so there is a single write authority; at minimum document which copy is canonical for rebuilds.

**Size:** S each.

### R8. Normalize runner result parsing and metadata extraction

**Problem.** Each runner parses its CLI's output ad hoc, and the shared result contract is too thin to carry what the CLIs already report. Concretely:

- **Contract:** `AgentRunTokenUsage` (`core/contracts.ts:18`) is just `{inputTokens, outputTokens}` — no cost, no cache tokens, no turn count, no CLI-reported duration. Even where a CLI offers the data, Wake has no slot for it; `tick-runner.ts` re-derives duration from wall-clock timestamps instead.
- **Claude:** `claudePrintResultSchema` captures `total_cost_usd` and passes through `num_turns` / `duration_ms`, but `extractTokenUsage` (`claude-runner.ts:182`) reads only `usage.input_tokens`/`output_tokens` and drops the rest. Cache tokens (`cache_read_input_tokens`, `cache_creation_input_tokens`) are excluded entirely — they dominate agent runs, so the token counts posted to GitHub can understate real usage by an order of magnitude.
- **Codex:** `extractCodexExecResult` (`codex-runner.ts:121`) calls `JSON.parse(line)` with no per-line try/catch — any non-JSON line on stdout (a warning, a stray log) throws and surfaces as an infra-failed run even when the agent finished fine. Only the *last* `turn.completed` usage is kept (verify whether Codex reports cumulative or per-turn usage; if per-turn, multi-turn runs are undercounted). No cost extraction.
- **Cursor:** `extractCursorAgentResult` reads `result` / `session_id` / `is_error` and discards everything else — Cursor runs report no usage at all.

**Proposed change.**

1. Widen the contract with optional fields: `cacheReadTokens`, `cacheCreationTokens`, `costUsd`, `numTurns`, `cliDurationMs`. Populate per CLI where available; leave absent otherwise. Downstream (publish-intent payload, GitHub comment) reports what exists — pairs with R2's "store raw numbers, format at the sink".
2. Make every JSONL/JSON parser tolerant and typed: per-line try/catch that skips non-JSON lines, zod-validated event shapes (discriminated union per event type) instead of bare `as` casts, and usage accumulated across turn events rather than last-write-wins.
3. Make the unified runner core (R1) own the normalized result assembly so each CLI strategy's only parsing job is "raw stdout → normalized result"; parsing quirks stay trapped inside the strategy.
4. Distinguish timeout/kill via the spawn signal and Wake's own timer rather than output text; keep substring-based quota heuristics confined to stderr (see S11).
5. Optional follow-up: move the Claude runner to `--output-format stream-json` with a line-buffered incremental parser — enables liveness heartbeats and salvages partial usage/output when a run is killed at timeout (today a timeout loses everything).

**Sentinel ABI note.** The `wake-result` fence parsing (`parseRunnerResult`) is a prose-channel protocol and will always be somewhat fragile, but it already degrades gracefully and records `envelope: structured|degraded` as drift telemetry. Harden it with a fixture corpus of real agent outputs rather than redesigning it; the DONE/BLOCKED distinction genuinely has to come from the model, unlike transport-level status, which should come from exit codes and signals.

**Size:** M standalone; S–M if done as part of R1 (recommended — the contract widening lands first, then R1 carries the parser consolidation). Fake runner must grow the same fields so tests exercise the full contract.

---

## C. Architectural opportunities

These go beyond cleanup — patterns worth adopting to strengthen Wake's control-plane story.

### I1. Eligibility decisions as named, traceable predicates

Today `policy.isEligible` + `needsWakeAction` return bare booleans, so "why didn't Wake pick up my issue?" requires reading code. Restructure the policy checks as an ordered list of named rules, each returning pass or a skip reason (`missing-required-label`, `ignored-label:<x>`, `failed-awaiting-human-reply`, `comment-already-handled`, …). The tick logs (or stores on the projection) the first skip reason per item. Zero token cost, large operability win, and it turns the policy engine into data that's trivially unit-testable rule by rule.

### I2. Attempt tracking with a quarantine state

Wake deliberately avoids retry-with-bigger-model, but it has no attempt memory at all: the projection doesn't count how many times an action ran for the same trigger. Combined with S9's fix (infra failures becoming retryable), you need a cap: persist `attempts[action]` in context, and after N consecutive infra failures move to a quarantined/parked state with a visible label + comment, requiring human action to release. Keeps the no-silent-escalation principle while preventing both stalls and loops.

### I3. Express the stage machine as one declarative table

Stage knowledge is currently spread across four files: `policy-engine.chooseAction` (stage→action), `lifecycle-service.nextStageFromSentinel` (action+sentinel→stage), `tick-runner.statusLabelForStage` (stage→status label), and `projection-updater` (session-clearing rules keyed on stage transitions). Adding a stage (see I4) means synchronized edits in all four. Define a single transition table in `domain/` — `{ stage, action, sentinel → nextStage, statusLabel, clearsSession }` — and have those modules read it. This is the enabler for making the pipeline configurable later without touching core logic.

### I4. Post-implement verification stage with an independent runner

The tier/routing model (`config.stages`, `config.tiers`) already supports pinning different runners per stage. A natural next pillar: an optional `review` stage between `implement` and `awaiting-approval`, executed by a *different* runner than the one that implemented (the projection already records `routing.runnerName` per run, so "reviewer ≠ implementer" is enforceable by the control plane, not by prompt). The reviewer emits the same sentinel ABI; `DONE` promotes to approval, `BLOCKED` returns feedback to the implement session. This buys real independence between producing and judging code at zero framework cost beyond I3.

### I5. First-class projection rebuild command

CLAUDE.md promises `state/` is rebuildable from `events/`, but there is no cold-rebuild entry point: `projectionUpdater.rebuildFromEvents` only folds increments onto existing projections. Add `wake rebuild [--repo <r>]` that replays the full event log into a fresh `state/`. This (a) proves the event-sourcing claim continuously, (b) makes projection-schema changes safe (change the fold, rebuild), and (c) is the recovery path for S5's corruption detection. Requires the event log to be truly sufficient — running it once will reveal any projection fields that currently only exist because of out-of-band writes.

### I6. Publish a JSON Schema for `config.json`

The zod schema can emit JSON Schema (e.g. via `zod-to-json-schema`). Have `wake init` write `config.schema.json` next to `config.json` and stamp `$schema` into the scaffolded config, so editors validate/autocomplete operator config. Cheap polish that reduces misconfiguration support load. (Remember the documentation rule: this changes the init output surface, so update `docs/configuration.md`.)

---

## D. Event-flow and transition audit (added 2026-07-11)

Item IDs use the `E` prefix (event-flow), continuing the S/R/I convention.

A focused pass over the event mechanism, stage transitions, workspace prep/teardown, and outbound delivery, looking for dead-letter scenarios, trapdoors, and gaps. Findings are ordered by severity.

### E1. Closed issues are never observed — the entire closed-issue path is unreachable

**Problem.** `github-client.ts:11` hardcodes `state: 'open'` in `listIssues`. A closed issue simply disappears from polling, so no `ticket.upsert` with `state: 'closed'` is ever ingested. The fake adapter is no better: `fake-ticketing-system.ts:54` hardcodes `state: 'open'` and `FakeTicketSeed` has no state field. Consequences:

- `cleanupClosedIssueWorkspaces` (tick-runner.ts:193) never fires in any real deployment — **workspaces leak forever**. The closed-issue cleanup logic is exercised only by tests that construct closed-state events by hand.
- `isEligible`'s `state !== 'open'` check is dead against real data.
- A closed issue's projection freezes at its last open state indefinitely: stage labels stay on the closed issue, the item clutters `listIssueStates` on every tick, and any `blocked`/`awaiting-approval` state just silently evaporates from the operator's view.

**Proposed change.** Poll with `state: 'all'` (bounded by `since` once S8 lands — closed issues stop appearing in a `since` window shortly after closing, which is exactly when the close event has already been ingested), and add a `state` field to `FakeTicketSeed` so the fake can exercise close/reopen flows. Also ingest a distinct `ticket.closed`-style transition (or derive it in the fold) so closing an in-flight issue explicitly cancels pending work: today, even with the state visible, a running/blocked item has no defined "the ticket went away" transition.

**Size:** M.

### E2. One un-deletable workspace bricks every tick (system-wide trapdoor)

**Problem.** `cleanupClosedIssueWorkspaces` is called unconditionally near the top of `runTick` (tick-runner.ts:339) with no error handling; `cleanupWorkspace` is `rm -rf`. If the directory can't be removed — `EBUSY`/`EPERM` are routine on Windows when an editor, terminal, or the agent's own leftover process holds a handle — the exception escapes `runTick` (the outer `try` has only a `finally`), the control plane logs and sleeps, and the **next tick hits the same directory before candidate selection again**. One locked folder halts all work for all repos, permanently, with only a repeated one-line error as evidence.

**Proposed change.** Wrap the per-item cleanup in try/catch: on failure, emit a `wake.workspace.cleanup-failed` event (visible, at most once per N ticks or with backoff recorded in the projection) and continue the tick. Cleanup is janitorial; it must never gate dispatch.

**Size:** S.

### E3. Polling is all-or-nothing across repos

**Problem.** `pollEvents` (github-issues-work-source.ts:285) iterates repos in one loop with no per-repo error isolation. One repo returning a 500/403 throws away events already gathered from earlier repos in the same poll (they're returned, not appended, so nothing is persisted) and aborts the whole tick. During a partial GitHub outage or a single revoked-repo permission, Wake does no work at all — including work items that need no new input.

**Proposed change.** Per-repo try/catch; return events from healthy repos, record the failure in the per-repo `sourceState` (it already exists) so staleness is observable. Optionally let the tick proceed on total poll failure using existing projections — the tick is projection-driven, so a source outage shouldn't stop runs whose inputs are already local.

**Size:** S–M.

### E4. `octokit.paginate` makes the polling caps meaningless

**Problem.** `listIssues`/`listComments` use `octokit.paginate(...)` with `per_page` (github-client.ts:8-27). `paginate` fetches **all pages**; `per_page` is the page size, not a limit. `maxIssuesPerRepo: 25` therefore caps nothing — on a repo with 3,000 open issues every tick fetches all 3,000 (plus all comments for each), which is both a rate-limit trapdoor and a config surface that silently doesn't do what it says.

**Proposed change.** Honor the cap: stop pagination once the limit is reached (octokit's `paginate` supports early termination via the `done()` callback), or fetch a single page. Fold into S8's incremental-polling work.

**Size:** S.

### E5. Outbound intents have no delivery guarantee — questions can be lost forever (dead letter)

**Problem.** Three related gaps:

1. **Silent drop:** GitHub `deliverIntent` returns `[]` when `sourceRefs.repo`/`issueNumber` are missing (github-issues-work-source.ts:359) — the intent is consumed with no delivery, no error, no event.
2. **No retry:** if `deliverIntent` throws (API blip), the intent event is already in the log but nothing ever re-attempts delivery. For a `BLOCKED` run this is the worst case: the agent's question never reaches GitHub, the issue sits in `blocked` waiting for a human reply to a comment that was never posted, and nothing surfaces the loss. Classic dead letter.
3. **Pre-run label delivery failure poisons state:** the `wake.run.claimed` labels event is delivered *before* the runner (tick-runner.ts:467) outside the inner try/catch. If it throws, the run record is left `running` and the claimed stage is already folded; the item is retried next tick while the orphaned record waits for stale reconciliation (see E6).

**Proposed change.** Adopt an outbox pattern over the existing event log: an intent is "delivered" only when a corresponding confirmation event (`ticket.reply.published` / `ticket.labels.updated` / an explicit `wake.publish.failed` terminal) exists. At tick start, scan for unconfirmed intents older than a small grace window and re-deliver (bounded attempts, then a visible dead-letter event). Case 1 should emit an explicit rejection event instead of `[]`. This also gives S1 its clean shape: run outcome recording and delivery become independent, retryable steps.

**Size:** M.

### E6. Stale-run reconciliation can poison a work item that already recovered

**Problem.** `reconcileStaleRunningRecords` (tick-runner.ts:240) marks any `running` record older than the timeout as `FAILED` and folds a `wake.run.completed(FAILED)` event — without checking whether that record is still the item's latest run. The E5-case-3 sequence makes this concrete: claimed-labels delivery throws → record stuck `running` → item retried next tick (its `lastCompletedAction` is unchanged, so `needsWakeAction` is true) → retry succeeds → ~30 minutes later reconciliation folds `FAILED` over the healthy projection: `lastRunSentinel=FAILED` blocks further action, the session ID is cleared, and failure labels are pushed to GitHub. A recovered item is silently re-broken.

**Proposed change.** Before reconciling, compare against the projection: skip (and just close the record as `superseded`) when `projection.wake.lastRunId !== record.runId` or a newer completed run record exists for the same work item.

**Size:** S.

### E7. Refine runs record the shared canonical clone as their workspace

**Problem.** For `refine`, `prepareReadOnlyClone` returns the canonical clone path (`.wake/repos/<repo>`), which flows into the `wake.run.completed` payload and thus `projection.wake.workspacePath`, and into the GitHub comment's "resume this session locally" instructions. Three hazards:

- The only thing preventing `cleanupClosedIssueWorkspaces` from `rm -rf`-ing the **shared clone** is the `isPerIssueWorkspacePath` prefix guard — a single load-bearing path check with no test of intent behind it.
- The resume comment tells a human to `cd` into the canonical clone — which `ensureCanonicalClone` will `reset --hard` + `clean -fdx` on the *next refine of any issue in that repo*, destroying whatever the human was doing there.
- Server-local filesystem paths are published into GitHub comments.

**Proposed change.** Don't record a `workspacePath` for read-only clones (or record it with a `role: 'shared-clone'` marker that both cleanup and the comment formatter respect). Suppress the `cd` hint when the path isn't a per-issue workspace.

**Size:** S.

### E8. Transient/orphan stage labels create invisible limbo states

**Problem.** During a run, the claimed stage (`refine` or `implement`) is published as a `wake:stage.*` label. `refine` is a *transient* stage: `chooseAction('refine')` returns `null` and the retry path only covers `blocked`/`failed`. If Wake crashes mid-refine and the failure-labels delivery never lands (E5), GitHub keeps `wake:stage.refine`, and label-wins reconciliation flips the projection back to `refine` on every poll — a stage with no action and no exit. The same limbo applies to a human hand-applying `wake:stage.refine` or `wake:stage.done` to an open issue. Nothing logs or surfaces "this item is in a stage I will never act on."

**Proposed change.** Two layers: (a) treat non-actionable stages explicitly in policy — map a synced `refine` back to `queue` (it's re-derivable work) and emit a visible reconciliation event for other dead-ends; (b) consider not publishing transient claimed-stage labels at all — `wake:status.working` already communicates "in progress", and stage labels could change only on completed transitions, removing the crash window. Complements I1 (skip reasons would at least make the limbo visible) and I3 (a declarative table is where "actionable vs transient" belongs).

**Size:** M.

### E9. Non-GitHub providers are structurally blocked in three places

**Problem.** The `WorkSource`/`OutboundSink` seam is genuinely provider-agnostic, but three things outside it aren't:

1. **Eligibility is GitHub-shaped in core:** `policy-engine.isEligible` reads `config.sources.github.policy` directly — core logic importing a provider-specific config path. A Jira/Linear/local-queue source has no way to express eligibility, and the "no labels and no assignees configured → nothing eligible" safety default means an adapter without label semantics can never activate anything.
2. **Numeric IDs are baked into the domain:** `issueSnapshot.number` and `sourceRefs.issueNumber` are `z.number().int().positive()`, and `state-store.issueRefFromWorkItemKey` parses `repo#<int>`. Providers with string keys (`PROJ-123`, UUIDs) cannot be represented without fabricating fake numbers.
3. **The fake's vocabulary leaks into core:** `projection-updater` special-cases `fake.issue.upsert` / `fake.issue.comment.created` alongside the normalized `ticket.*` types. New adapters must guess that `ticket.upsert` is the contract; the fake should emit the normalized vocabulary itself so core knows exactly one.

Additionally, self-reply protection is fragile per-provider: loop prevention depends on `expectedEcho.commentIds`, which depends on `extractCreatedCommentId` understanding the provider's create-comment response. If a new sink's response shape differs, echo suppression fails silently and Wake's own comments look human (`botAuthoredComment` is adapter-supplied too) — the result is Wake replying to itself in a token-burning loop. A second-layer guard (match comment author against the sink's own identity/marker — the `**Wake**` header is already there) would make the failure mode safe by default.

**Proposed change.** (1) Move eligibility policy to a provider-neutral shape (`sources.<name>.policy` consumed via the WorkSource, or a policy input the adapter normalizes into the projection). (2) Widen work-item identity to an opaque string key with numeric issue number as a GitHub-specific ref. (3) Have the fake emit `ticket.*` and delete the `fake.*` branches from core. (4) Add author-identity echo detection in the fold. Item 2 is a schema migration — do it before the event log accumulates much history.

**Size:** M–L (item 2 dominates).

### E10. Dead or decorative control surfaces

- `EventEnvelope.trigger` (`immediate` | `context-only`) is set by every producer and read by **no one** — candidate selection is purely projection-based. Either wire it in (e.g. `context-only` events shouldn't flip `needsWakeAction`) or remove it before more producers cargo-cult it.
- `sources.github.publication.postStatusComments` defaults to `true` and is never read — an operator setting it to `false` still gets comments. Same class as the dead `lookbackMs` (S8): config that silently does nothing. `activeLabel` likewise.
- `buildCodexResumeArgs` / `buildCursorResumeArgs` exported and unused (already S7).

**Proposed change.** Honor `postStatusComments` in `deliverIntent` (skip comment posting, still confirm the intent as intentionally-suppressed so E5's outbox doesn't retry it); delete or wire `trigger` and `activeLabel`. Per the documentation rule, reconcile `docs/configuration.md` in the same change.

**Size:** S.

### E11. Non-atomic state writes turn crashes into token-burning re-runs

**Problem.** `writeJsonFile` writes in place (json-file.ts:4) — no temp-file + rename. A crash mid-write leaves truncated JSON, which the state store's catch-all (S5) reads as "missing". For an issue projection that means: on restart the issue looks brand-new → re-ingested at `queue` → a fresh refine run is dispatched (token spend), and `lastHandledCommentId` is gone so old human comments look unhandled. The two-write `appendEventEnvelope` (JSONL + by-id file) has the same crash window between writes. Related: event IDs are unique by convention only — `appendEventEnvelope` happily appends duplicate lines (see S1's duplicate `-completed` ID, and E12), which a future full replay (I5) would double-apply.

**Proposed change.** Write-to-temp + `rename` in `writeJsonFile` (cheap, platform-portable); make `appendEventEnvelope` idempotent by checking the by-id file first and skipping known IDs.

**Size:** S.

### E12. The fake work source floods the event log with duplicates every tick

**Problem.** The GitHub source deduplicates against local state before emitting (`updatedAt` comparison); the fake source has no change detection — `pollEvents` re-emits every fixture issue and comment **every tick** with stable event IDs, and `runTick` appends all polled events unconditionally. Running `npm run start` against fixtures grows `events/*.jsonl` with identical envelopes every interval, and each re-folded upsert pushes real events (like `wake.run.completed`) out of the 10-slot `recentEventIds` window — so the context handed to the runner fills with duplicate upserts instead of run history. The fake is documented as a permanent contract-parity harness; on inbound dedup semantics it has drifted from the real contract.

**Proposed change.** Either give the fake the same "emit only on change" behavior (compare against the state store, as the GitHub source does), or — better, because it protects every future adapter — make ingestion idempotent at the store (E11's by-id check) so duplicate emission is harmless by construction.

**Size:** S.

### E13. No quota backoff — a 429 turns into a comment-spamming retry loop

**Problem (observed in production).** On 2026-07-07 22:24–22:30, issue #121 ran **five failed refine runs in five minutes** (one per tick), each burning a runner invocation and posting a failure comment to the real GitHub issue. Root cause per the run metadata: Claude CLI returned `api_error_status: 429, "You've hit your session limit · resets 1:10am (UTC)"`. Nothing in the control plane treats `failureClass: 'quota'` differently from any other failure, so Wake retried at full tick cadence against a limit that the error message *said* wouldn't reset for hours. Meanwhile the mechanism built for exactly this — `ledger.json`'s `pausedUntil` (schema.ts:257) — is written/readable via the state store but **never consulted**: `isPaused()` only checks the `PAUSE` file, and nothing ever sets `pausedUntil`.

**Proposed change.** Wire the dead mechanism: when a run fails with `failureClass: 'quota'`, set `pausedUntil` (parse the reset time from the error when present, else exponential default), and make `isPaused()` honor it alongside the PAUSE file. This is a control-plane concern, not a runner concern — no retry-with-bigger-model, just "stop ticking until the quota window turns over." Also stop posting a GitHub comment per quota failure (one "paused until X" comment, or none — the label is enough).

**Size:** S–M.

### E14. A FAILED run strands the item in a transient stage with no exit (observed)

**Problem.** When a runner returns `FAILED`, `nextStageFromSentinel` returns `null`, so the projection **keeps the claimed stage** (`refine` or `implement`). For `implement` that's survivable (`chooseAction('implement')` still works). For `refine` it's a dead end: `chooseAction('refine')` is `null` and `chooseRetryActionAfterHumanReply` only fires for `blocked`/`failed` stages — which are unreachable from a normal runner failure (`failed` stage is only ever set by stale-run reconciliation, confirmed in the logs: exactly the 2 stale-reconciled records produced the only 2 `failed`-stage projections). So after a failed refine, **no human comment can revive the issue** — the reply passes the `needsWakeAction` gate but no action can be chosen, and the item silently drops out of candidacy forever. Production data shows 18 failed refine runs; the ones that recovered did so only because labels were later changed out-of-band or a newer Wake version re-queued them.

**Proposed change.** Make `FAILED` a real transition: fold it to the `failed` stage (which already has the human-reply retry path) instead of `null`/stay-put. This also collapses the E8 limbo for the crash case and makes `lifecycle-service` total over its inputs. Requires updating the projection-updater session-clearing logic and the two policy checks that assume the current behavior.

**Size:** S–M (semantics change; test the blocked/failed/awaiting matrix).

---

## E. Production evidence (wake-home logs, reviewed 2026-07-11)

A pass over the live `~/wake-home` deployment (2,210 events over 5 days, 188 run records, 94 projections) validates several items empirically and calibrates priorities:

- **E1 confirmed:** 0 of 94 projections have `state: 'closed'` — despite 30 items at stage `done` whose issues are long closed on GitHub. The closed-issue path has literally never executed.
- **Sentinel parsing is the #1 quality problem — 35% degraded.** Of 60 `wake.run.completed` events carrying an envelope marker, 21 were `degraded` and 15 of those became `FAILED`. Sampling the failed bodies shows the agent *complying in intent but not in format*: full implementation plans and clarifying questions ending in `**BLOCKED**` (bold — fails the exact-match), `wake-result` on the line *after* the fence opener, or the sentinel inside the fence in ways the fallback missed. These were real questions to humans, dead-lettered as failures. This upgrades R8's "fixture corpus" note to a priority: build the corpus directly from these logged bodies, make sentinel extraction tolerant of markdown decoration, and consider treating a substantive degraded body as `BLOCKED` (needs human) rather than `FAILED` — the data says that's what it almost always is.
- **E13 observed live:** the 5-runs-in-5-minutes 429 loop on issue #121, including 5 failure comments posted to the issue.
- **S3 confirmed at scale:** 12 of 94 projections carry the legacy `blockedFromAction` key.
- **E7 confirmed:** 10 projections have `workspacePath` pointing at the shared canonical clone (`repos/…`), not a per-issue workspace.
- **E11/E12 confirmed (mildly):** 3 duplicated inbound event IDs in the JSONL log (issue #179 comment/upsert ingested twice).
- **Environment-config failures produce infra-failed runs instead of failing fast:** `ENOENT C:\wake\prompts\implement.start.md` (host-style path used inside the sandbox, ×2), `spawn cursor ENOENT` (CLI not installed, ×1), `git clone --local` failures from an older workspace-manager version (×6), and Codex/Cursor "produced no output" (×4). All of these are detectable at startup — a preflight validation (prompts resolvable, runner binaries present, canonical clone healthy) would turn per-run token-adjacent failures into immediate, clear boot errors. Fold the binary check into R1 (a per-strategy availability probe is a natural capability of the unified runner core).
- **Self-echo re-triggering appeared in the #121 loop:** each failure comment Wake posted came back through polling as a `ticket.comment.created` roughly one second after `ticket.reply.published`. Whether or not current echo suppression fully covers this version's gap, it is direct evidence for E9's recommendation of a second-layer author-identity guard — echo bookkeeping alone has already failed once in production.

---

## F. Suggested sequencing

1. **Wave 1 — correctness (small, independent):** E2, E4, E6, E11, E13, E14, S2, S3, S4, S9, R5 (+ R7 typo). Each is a focused PR with tests. E2 and E11 first — they are the cheapest fixes for the worst failure modes; E13 and E14 are both production-observed.
2. **Wave 2 — the tick runner and delivery:** S1 + E5 together (they define the same boundary: run outcome vs. delivery, with the outbox giving retries), then R2. E1 alongside (closed-issue observation + cancel transition), with E7 as a small rider.
3. **Wave 3 — the runner layer:** R8 step 1 (widen the result contract + fake runner) first as a small standalone PR, then R1 folding in S7, S11, and the rest of R8 (tolerant typed parsers, normalized result assembly), then R3 on top. Largest single payoff; do as one branch with the existing runner tests as the harness.
4. **Wave 4 — observability & hygiene:** I1, S5, S6, S10, R4, R6, E8, E10, E12.
5. **Wave 5 — capability:** S8 + E3 (incremental, fault-isolated polling), E9 (provider neutrality — schedule the ID-widening early within this wave, before the event log grows), I2, I3 → I4, I5, I6.

Nothing here changes `core/contracts.ts`, so fake adapters and the zero-token test strategy stay intact throughout; the only contract-adjacent change is R1, which lives entirely behind `AgentRunner`.
