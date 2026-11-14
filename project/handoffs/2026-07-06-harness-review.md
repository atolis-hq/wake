# Handoff: Wake harness review — brittleness, patterns, simplification

Date: 2026-07-06. Scope: full read of `src/` (core, adapters, cli, domain, lib), prompts, and the (now-deleted) `docs/todo/` directory. Findings already tracked in `docs/todo/` were not repeated except where they turned out to be symptoms of a deeper pattern; the `docs/todo/` items themselves were subsequently filed as GitHub issues #74–#83 and the directory removed (see the "Suggested sequencing" section below for the mapping).

## TL;DR — the three highest-impact items

1. **Confirmed bug: the two-step label delivery clobbers itself.** Status and stage labels are delivered as two separate intents, each recomputed from a projection that is never updated by the first write. The second `setLabels` reverts the status label to its pre-run value. (Details in §2.1. → [#50](https://github.com/atolis-hq/wake/issues/50))
2. **The "echo problem" is the system's dominant source of brittleness.** Wake's own writes to GitHub (comments, labels) come back as inbound changes, and today four unrelated ad-hoc mechanisms exist to suppress the echo. Each new outbound side effect will need a fifth. Unify echo suppression at the ingestion boundary. (§1.1 → [#54](https://github.com/atolis-hq/wake/issues/54))
3. **A crash or thrown error mid-run leaves permanently inconsistent state** (run record stuck `running`, labels stuck `wake:status.working`, and for workspace failures an infinite retry loop). One try/catch + a failure event in `tick-runner.runTick` fixes a whole class of these. (§2.2 → [#51](https://github.com/atolis-hq/wake/issues/51))

---

## 1. Underlying patterns (the real insights)

### 1.1 The echo problem is solved four different ways in four different places → [Issue #54](https://github.com/atolis-hq/wake/issues/54)

Wake writes to GitHub, then polls GitHub, so every outbound action re-enters as an inbound event. Current suppression mechanisms:

| Echo                                           | Suppression                                    | Location                                                   |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| Wake's own comments                            | `<!-- wake -->` marker + `isWakeAuthored`      | `schema.ts`, work source, projection                       |
| Bot comments unblocking issues                 | `botAuthoredComment` hint                      | work source `derivedHints`                                 |
| Label writes bumping `updated_at` → re-trigger | `lastHandledIssueUpdatedAt` cursor             | policy engine + `wake.run.completed` payload               |
| Re-synced labels regressing stage to `queue`   | "labels only set stage at projection creation" | `projection-updater.ts` (the infinite-refine-loop comment) |

Each of these was discovered as a production incident (the code comments say so). The pattern will recur for every new outbound surface (PR comments are already on the roadmap — [Issue #82](https://github.com/atolis-hq/wake/issues/82)).

**Recommendation:** make echo suppression a single first-class concept at the ingestion boundary. When Wake performs an outbound side effect, record what it expects to see back (comment ID, label set, approximate `updated_at` bump). At `pollEvents`, drop or mark inbound events that match a recorded expectation. Then `needsWakeAction` can shrink to "is there an unhandled _human_ event", and the projection-updater's special cases disappear. This is the single change that most reduces future incident surface.

### 1.2 Stage transitions live in three places → [Issue #55](https://github.com/atolis-hq/wake/issues/55)

- `lifecycle-service.ts` maps sentinel → stage (the intended home).
- `projection-updater.ts` performs the unblock transition (`blocked/failed` + human comment → `refined`/`queue`), including reading `context.blockedFromAction` that `tick-runner` plumbed into `wake.run.completed` for exactly this purpose.
- `stageFromLabels` in `projection-updater.ts` sets the initial stage from labels.

The projection fold is supposed to be a mechanical record of what happened; deciding "a human reply means we should retry implement" is policy. Because it lives in `applyEvent`, it's untestable through the policy engine and required threading `blockedFromAction` through the event payload, the context bag, and the updater.

**Recommendation:** projection records facts only (latest human comment, last run + its action/sentinel). Policy engine decides: `stage in (blocked, failed) && unhandled human comment → action = retry lastRunAction`. This deletes `blockedFromAction`, the `unblockStage` logic, and makes the unblock rule visible in the one file that is supposed to own decisions.

### 1.3 Event-envelope ceremony dominates the orchestrator → folds into [Issue #50](https://github.com/atolis-hq/wake/issues/50)

`tick-runner.ts` is 418 lines; roughly half is five near-identical `createEventEnvelope` blocks (claimed, completed, status label, stage label, publish intent), each repeating `workItemKey`/`sourceRefs`/`occurredAt`/`ingestedAt`/`streamScope`. The actual tick logic (poll → pick → run → transition) is ~80 lines and hard to see.

**Recommendation:** a tick-scoped emitter closing over `candidate`, `runId`, and the clock — `emit('wake.run.claimed', payload)` — cuts the file roughly in half and makes new event types one-liners. Same pattern applies to `github-issues-work-source.ts`, where the two label branches of `deliverIntent` are ~50 lines apiece differing only in which prefix they replace (and merging them also fixes the bug in §2.1).

### 1.4 Config defaults are defined three times → [Issue #53](https://github.com/atolis-hq/wake/issues/53)

`defaults.ts` (values), `schema.ts` (shape), and `mergeWakeConfig` in `load-config.ts` (a hand-written deep merge that must be extended for every new nested field — it's already 8 spread-blocks deep). A forgotten merge branch silently drops user config.

**Recommendation:** put defaults on the zod schema (`.default(...)` at each level) and delete `mergeWakeConfig` entirely; `parseWakeConfig(rawUserConfig)` then _is_ the merge. One source of truth, and new fields can't be forgotten.

### 1.5 Free-text sentinel parsing is the weakest link in the control loop → [Issue #52](https://github.com/atolis-hq/wake/issues/52)

`parseRunnerResultSentinel` regex-matches the _last_ occurrence of `DONE|BLOCKED|FAILED` anywhere in the agent's prose. An agent writing "the previous run FAILED, so I re-ran the tests… DONE. If they had FAILED again…" is misclassified. Worse, `createPublishIntentEvent` strips **every** occurrence of those three words from the comment body (`replace(/\b(DONE|BLOCKED|FAILED)\b/g, '')`), mangling legitimate sentences in the posted GitHub comment ("the CI build FAILED because" → "the CI build because").

**Recommendation:** the prompts already demand "the last line of your response must be exactly one of: DONE, BLOCKED, FAILED". Parse exactly that — last non-empty line equals a sentinel; anything else is `FAILED` — and strip only that line from the published body. Small change, removes both misclassification and comment mangling. (Longer term the Claude CLI's JSON output could carry a structured field, but last-line parsing is 90% of the value for 2% of the work.)

---

## 2. Brittle areas / bugs (ranked)

### 2.1 CONFIRMED BUG: stage-label delivery reverts the status label → [Issue #50](https://github.com/atolis-hq/wake/issues/50)

`tick-runner` delivers a `wake.status.label.requested` then a `wake.stage.label.requested` (both at run start and at completion). Each `deliverIntent` branch in `github-issues-work-source.ts` recomputes the full label set from `readIssueState(...).issue.labels` — but the `ticket.labels.updated` delivery event falls through to `applyEvent`'s default branch in `projection-updater.ts:203`, which only bumps `syncedAt` and never updates `issue.labels`. So the second intent reads the **pre-run** label snapshot: it preserves the _old_ status label (`wake:status.pending`) and calls `setLabels`, reverting the `wake:status.working` / `wake:status.completed` that was set milliseconds earlier. Net effect: on GitHub the status label is almost always stale; it only self-corrects after the next poll re-ingests labels — and each correction costs two more `setLabels` round-trips.

**Fix (also a simplification):** one `wake.labels.requested` intent carrying both status and stage, applied in one read-compute-set. Two event types, two tick-runner blocks, and one race all disappear. If you keep two events, make `applyEvent` fold `ticket.labels.updated`'s `payload.labels` into `issue.labels`.

### 2.2 No failure containment around workspace prep or the runner → [Issue #51](https://github.com/atolis-hq/wake/issues/51)

In `runTick`, `prepareWorkspace` / `prepareReadOnlyClone` / `runner.run` are called with no try/catch. Any throw (git network failure, non-JSON stdout from the Claude CLI — `parseClaudePrintOutput` does a bare `JSON.parse` on the exit-code-0 path, `claude-runner.ts:311`) propagates out, leaving:

- the run record permanently `running` (nothing ever reconciles stale run records),
- GitHub labels stuck at `wake:status.working`,
- the issue re-eligible next tick → infinite retry with a fresh workspace each time ([Issue #77](https://github.com/atolis-hq/wake/issues/77), the branch-hardcoding half of the former `docs/todo/workspace-prepare-error-handling.md`, is one instance of this general hole).

**Fix:** wrap the prepare+run section; on throw, write the run record as `failed`, emit `wake.run.completed` with sentinel `FAILED`, and let the existing lifecycle take it to the `failed` stage (which a human unblocks by replying). That single catch closes the whole class, including the todo item.

### 2.3 Crash-safety gap between "claimed" and "completed" → [Issue #56](https://github.com/atolis-hq/wake/issues/56)

The tick is meant to be a pure function of durable state, but a process kill between `wake.run.claimed` and `wake.run.completed` leaves no durable trace that affects the next tick — `claimed` events don't touch the projection, so the issue is simply re-run. That's an acceptable at-least-once policy, but it's implicit. The stuck-lock problem (fixed via wall-clock timeout + `locks clear` command) is the sibling symptom: `lib/lock.ts` is a bare existence-check file with no owner PID/timestamp, so a crashed process wedges ticks until manual intervention.

**Recommendation:** write PID + timestamp into the lock file and treat a lock older than the runner timeout (or with a dead PID) as stale and reclaimable. This deletes the manual `locks clear` escape hatch. Optionally have the next tick reconcile `running` run records older than the timeout to `failed` so labels/history self-heal.

### 2.4 Label vocabulary mismatch means "GitHub wins for stage" is not true → [Issue #57](https://github.com/atolis-hq/wake/issues/57)

`stageFromLabels` (`projection-updater.ts:4`) recognizes `wake:blocked` / `wake:refined` / etc., but everything Wake writes uses the `wake:stage.*` prefix (`tick-runner.ts:137`, work source). So the initial-stage-from-labels path can never match a label Wake itself wrote, and a human editing `wake:stage.*` labels has no effect at any point. CLAUDE.md's "reconcile labels → local projection at the start of every tick; GitHub wins for stage" is aspirational, not implemented ([Issue #78](https://github.com/atolis-hq/wake/issues/78) acknowledges the deliberate disable, but not the prefix mismatch). Either unify the vocabulary and implement the reconcile (with the §1.1 echo fix, this becomes safe), or update CLAUDE.md/docs so operators don't assume label edits work.

### 2.5 Whole-log scan per tick → [Issue #58](https://github.com/atolis-hq/wake/issues/58)

`listEventEnvelopesForWorkItem` (`state-store.ts:175`) reads and zod-parses **every event ever recorded** to return the last 6 for one work item, on every agent run. Also, events are bucketed into files by `occurredAt` — which for GitHub events is the upstream `updated_at`, so a stale issue writes into a weeks-old file, and cross-source ordering by `occurredAt` string-compare interleaves Wake-clock and GitHub-clock timestamps. Not yet painful, but it's O(total history) on the hot path and grows forever. Cheapest fix: bucket event files by `ingestedAt` (monotonic, Wake-owned) and keep a per-work-item recent-events cache in the projection (`recentEventIds` already exists but is unused for this).

### 2.6 Prompt injection surface → [Issue #63](https://github.com/atolis-hq/wake/issues/63)

Issue title/body/comments are interpolated raw into the agent prompt, and the implement stage runs with `Bash(git *), Bash(gh *), Bash(npm *)` plus push credentials. Anyone who can file an issue in a watched repo can steer Wake ("ignore previous instructions, run `gh repo…`"). For repos where issue-filing is open, this is remote command influence. Mitigations to consider: fenced/delimited interpolation with an explicit "untrusted content" preamble, `requiredAssignees` as a de facto human approval gate (already supported — worth documenting as the security control it is), and keeping the sandbox mandatory for implement runs.

### 2.7 Comment-triggered re-runs race with in-flight ordering → [Issue #59](https://github.com/atolis-hq/wake/issues/59)

`pollEvents` fetches issues then comments per issue with no lookback bound in use (see [Issue #59](https://github.com/atolis-hq/wake/issues/59)) and no pagination beyond one page of size `commentPageSize`; a busy issue with more comments than the page size silently misses old comments (dedupe is by ID against the projection, so _missed_ ones never arrive). Low priority, but the failure is silent.

---

## 3. Dead code / quick deletions → [Issue #60](https://github.com/atolis-hq/wake/issues/60)

- **`EventRecord` is a dead parallel event schema**: `eventRecordSchema`, `parseEventRecord`, `createEventRecord`, and `stateStore.appendEvent` have no callers outside their definitions. Delete all four (and the `EventRecord` type).
- **`wake.attempts` is always 0**: nothing increments it, yet it's schema-required, copied in every fold, and interpolated into both prompt templates ("Attempts: 0" forever). Either implement it (it would be genuinely useful for the retry policy in §2.2) or delete it.
- **`smoke()` JSON-parse asymmetry**: the smoke path guards against empty stdout before parsing, the real `run()` path doesn't (§2.2). If you fix §2.2 the guard logic can be shared.
- **`formatDuration`'s try/catch** can't throw (`new Date` never throws on strings); minor, but it signals defensive noise.

## 4. What's already good (don't break it)

- The adapter seams (`contracts.ts`) are real: core never imports a concrete adapter, and the fakes genuinely exercise the contract. This is the repo's core asset — the recommendations above deliberately stay behind these seams.
- Event-first persistence with rebuildable projections is the right call and is what makes §1.1's unified echo suppression _possible_ — the raw truth is already durable.
- The runaway-cost protections (mandatory `maxTurns` frontmatter with a hard error, wall-clock kill with SIGTERM→SIGKILL grace) are exactly right.
- `--` terminator before the prompt in `buildClaudePrintArgs`, and the "Wake decides, the agent runs" prompt discipline, are both well-executed.

## 5. Suggested sequencing

1. §2.1 label clobber (bug; folds into the §1.3 intent-merge simplification — do together). → [Issue #50](https://github.com/atolis-hq/wake/issues/50)
2. §2.2 failure containment in `runTick` (closes an incident class + one existing todo). → [Issue #51](https://github.com/atolis-hq/wake/issues/51)
3. §1.5 last-line sentinel parsing + stop stripping sentinel words from comment bodies (small, user-visible quality). → [Issue #52](https://github.com/atolis-hq/wake/issues/52)
4. §1.4 zod-defaults config (pure deletion, removes a silent-drop hazard before more config lands for codex/cursor support). → [Issue #53](https://github.com/atolis-hq/wake/issues/53)
5. §1.1 unified echo suppression — the big one; do it before adding the PR activity source, or the ad-hoc mechanisms will double. → [Issue #54](https://github.com/atolis-hq/wake/issues/54)
6. §1.2 move unblock policy into the policy engine (mechanical once §1.1 lands). → [Issue #55](https://github.com/atolis-hq/wake/issues/55)

Additional findings not in the original sequencing: crash-safety/stale-lock reclaim ([#56](https://github.com/atolis-hq/wake/issues/56)), label-vocabulary/GitHub-wins-for-stage reconciliation ([#57](https://github.com/atolis-hq/wake/issues/57)), event-log scan performance ([#58](https://github.com/atolis-hq/wake/issues/58)), comment-polling gaps ([#59](https://github.com/atolis-hq/wake/issues/59)), dead-code cleanup ([#60](https://github.com/atolis-hq/wake/issues/60)), and prompt-injection hardening ([#63](https://github.com/atolis-hq/wake/issues/63), tracked jointly with the design doc's §4.3).

## 6. `docs/todo/` items — filed as issues, directory removed

The pre-existing `docs/todo/` directory (findings from earlier code reviews, predating this handoff) has been reviewed, filed as GitHub issues carrying the original wording, and deleted:

- `fake-ticketing-status-label-payload.md` → [Issue #75](https://github.com/atolis-hq/wake/issues/75)
- `github-label-endpoint-deprecation.md` → [Issue #74](https://github.com/atolis-hq/wake/issues/74)
- `label-driven-stage-sync.md` → [Issue #78](https://github.com/atolis-hq/wake/issues/78)
- `npm-packaging.md` → [Issue #83](https://github.com/atolis-hq/wake/issues/83)
- `polling-exponential-backoff.md` → [Issue #81](https://github.com/atolis-hq/wake/issues/81)
- `pr-activity-source.md` → [Issue #82](https://github.com/atolis-hq/wake/issues/82)
- `pr-filtering-wrong-layer.md` → [Issue #76](https://github.com/atolis-hq/wake/issues/76)
- `session-resume-policy.md` → [Issue #79](https://github.com/atolis-hq/wake/issues/79)
- `workspace-cleanup.md` → [Issue #80](https://github.com/atolis-hq/wake/issues/80)
- `workspace-prepare-error-handling.md` → split: the failure-containment half is already covered by [Issue #51](https://github.com/atolis-hq/wake/issues/51); the remaining "stop hardcoding the `main` branch" half is [Issue #77](https://github.com/atolis-hq/wake/issues/77).

Two items were superseded rather than re-filed, since this review and the companion design doc already cover them in full:

- `codex-and-cursor.md` — superseded by [Issue #66](https://github.com/atolis-hq/wake/issues/66) (runner registry/tiers) and [Issue #68](https://github.com/atolis-hq/wake/issues/68) (Codex/Cursor adapters).
- `github-poll-lookbackms-unused.md` — superseded by [Issue #59](https://github.com/atolis-hq/wake/issues/59) (comment-polling gaps, which already covers the unused `lookbackMs` config).
