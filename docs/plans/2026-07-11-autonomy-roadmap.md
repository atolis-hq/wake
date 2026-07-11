# Wake Autonomy Roadmap

**Date:** 2026-07-11
**Author:** Wake (Claude), with decision authority delegated by the operator.
**Purpose:** the ordered path from "human upgrades Wake" to "Wake upgrades Wake, human approves PRs". This document is the working plan; the operator's brief and constraints are recorded in §1 so they survive context loss.

## 1. Operating brief and constraints (as given by the operator, 2026-07-11)

- **Mission:** Wake is an agent orchestration control plane. The goal is for Wake to improve itself — pick up its own backlog, execute, and converse with humans where they work — as autonomously as possible, as soon as possible. The operator will assist only until no longer needed.
- **Current capability:** Wake picks up GitHub issues and executes them through to PR, with human-in-the-loop conversation. Upgrading Wake itself still depends on a human driving sessions.
- **Hard constraints:**
  1. **Token budget:** $20 Claude Pro plan, $20 ChatGPT Codex plan, free Cursor plan. Wake can delegate to any of these CLIs. Usage limits *will* be hit.
  2. **Human approval:** every change must be approved by a human, at minimum at the pull request.
  3. **No limit resilience today:** when a usage limit is hit there is no fallback to another CLI and no resume when the limit resets. Work just fails.
- **Known state:** there is an existing backlog of GitHub issues, a recent improvement report (`docs/reports/2026-07-10-simplify-solidify-refactor.md`) with production-log evidence, and likely latent bugs that interrupt work.

## 2. Strategy

The scarce resources are (a) tokens and (b) human attention. Autonomy is maximized by making every run count and every human touch high-leverage:

- **Dogfood from day one.** Wake's own repo is a Wake work source. Each roadmap item becomes a GitHub issue sized S–M (one focused PR, reviewable in minutes), so Wake executes its own upgrade path and the human's only job is review/approve.
- **Reliability before capability.** A latent bug that bricks the tick loop or dead-letters an agent question costs more autonomy than any new feature buys. Production evidence (report §E) says these bugs are real and frequent — fix them first.
- **Quota is the operating condition, not an edge case.** On $20 plans, hitting limits is normal. Pause/resume/fallback across the three CLIs is the single biggest autonomy multiplier after basic loop stability.
- **Small PRs, no big-bang refactors early.** Large refactors (R1 runner unification) wait until the loop is stable enough that Wake itself can execute them.

## 3. Phased plan

Report item IDs (E/S/R/I) refer to `docs/reports/2026-07-10-simplify-solidify-refactor.md`. Existing issue numbers are noted; items without an issue need one filed (see §4).

### Phase 0 — Stop the loop from dying (highest priority)

Every item here is production-observed or a confirmed trapdoor. All are S or S–M.

| Order | Status | Item | Why first | Issue |
|-------|--------|------|-----------|-------|
| 0.1 | Done | ~~**E2** — guard workspace cleanup so one locked dir can't brick every tick~~ | Single point of total failure, S-sized | file new |
| 0.2 | Done | ~~**E13 + [#112](https://github.com/atolis-hq/wake/issues/112) + [#113](https://github.com/atolis-hq/wake/issues/113)** — quota pause via `pausedUntil` ledger, resume on reset~~ | Observed 429 loop burned 5 runs + spammed comments in 5 min; on $20 plans this recurs daily | [#112](https://github.com/atolis-hq/wake/issues/112), [#113](https://github.com/atolis-hq/wake/issues/113) |
| 0.3 | Done | ~~**E14** — retain the current stage on `FAILED`, record failed status, and make failed refines recoverable from run context~~ | 18 production runs stranded unrecoverably | file new |
| 0.4 | Done | ~~**Sentinel tolerance** (R8 subset, [#163](https://github.com/atolis-hq/wake/issues/163)) — parse `**BLOCKED**`, off-fence sentinels; treat substantive degraded output as BLOCKED not FAILED~~ | 35% of runs hit degraded parsing; real human questions dead-lettered as failures — direct token waste | [#163](https://github.com/atolis-hq/wake/issues/163) |
| 0.5 | Done | ~~**S3** — normalize legacy `blockedFromAction` → `lastRunAction` in schema preprocess~~ | 12 of 94 live projections silently never retry | file new |
| 0.6 | Done | ~~**E11** — atomic writes (temp+rename) and idempotent event append~~ | Crash mid-write → re-ingestion → duplicate token spend | file new |
| 0.7 | Done | ~~**E6** — stale-run reconciliation must not poison recovered items~~ | Silently re-breaks healthy work | file new |

### Phase 1 — Protect human bandwidth and the approval gate

| Order | Status | Item | Why | Issue |
|-------|--------|------|-----|-------|
| 1.1 | Done | ~~**E5** — outbox/delivery confirmation for outbound intents~~ | A lost BLOCKED question stalls an issue invisibly; humans can't answer what they never saw | file new |
| 1.2 | Done | ~~**S2 + [#143](https://github.com/atolis-hq/wake/issues/143) + [#145](https://github.com/atolis-hq/wake/issues/145)** — strict `/approved` parsing, control-plane-enforced approval, reliable bot-comment detection~~ | Approval-gate integrity is the human-trust constraint; a spurious approval or a re-run triggered by a clarifying question wastes both budgets | [#143](https://github.com/atolis-hq/wake/issues/143), [#145](https://github.com/atolis-hq/wake/issues/145) |
| 1.3 | Done | ~~**S9** — infra failures must not consume the triggering human comment~~ | A human's retry request being silently eaten forces a second human touch | file new |
| 1.4 | Done | ~~**S1** — narrow tick-runner try/catch; stop rewriting successful runs as failed~~ | Durable-record corruption misleads both Wake and the human | file new |

### Phase 2 — Quota economy (the autonomy multiplier)

| Order | Item | Why | Issue |
|-------|------|-----|-------|
| 2.1 | **[#67](https://github.com/atolis-hq/wake/issues/67)** — durable quota/health ledger with **sideways fallback** (Claude → Codex → Cursor) and rotation | Directly removes the "no fallback when limits hit" constraint; three budgets become one pooled budget | [#67](https://github.com/atolis-hq/wake/issues/67) |
| 2.2 | **[#135](https://github.com/atolis-hq/wake/issues/135)** — token/cost usage metrics (needs R8 step 1: widen `AgentRunTokenUsage` with cache tokens, cost, turns) | Can't manage a budget you can't see; cache tokens currently understate usage by ~10x | [#135](https://github.com/atolis-hq/wake/issues/135) |
| 2.3 | **S8 + E4 + E3 + [#59](https://github.com/atolis-hq/wake/issues/59)** — incremental GitHub polling (`since` cursor), honor `maxIssuesPerRepo`, per-repo fault isolation | GitHub rate limit is a fourth budget; full-scan polling burns it and E3 makes one bad repo halt everything | [#59](https://github.com/atolis-hq/wake/issues/59) |
| 2.4 | **[#81](https://github.com/atolis-hq/wake/issues/81)** — exponential backoff on the resident-loop cadence | Cheap polling when idle | [#81](https://github.com/atolis-hq/wake/issues/81) |
| 2.5 | **Startup preflight** (report §E) — validate prompts, runner binaries, clone health at boot | Turns config mistakes into instant boot errors instead of failed runs | file new |
| 2.6 | **Automated self-update with rollback and self-heal** — host-side updater that polls `main` (CI already auto-tags releases), then: safe-stop Wake ([#111](https://github.com/atolis-hq/wake/issues/111)), `git pull` the checkout, `sandbox build` + `sandbox update`, health-check the new container. On failure: roll back to the last-known-good image, mark the bad tag in a host-side ledger (never retried), and **file a GitHub issue on the wake repo with the captured boot/build logs** — the still-running last-good Wake then fixes its own failed rollout as an ordinary work item; the updater tries again only when a *newer* tag appears | Deployment is the last per-change human dependency. Rollback alone would pin Wake on the old version forever; filing the failure as an issue closes the loop so a bad rollout becomes self-healing. Must not update mid-run (needs [#111](https://github.com/atolis-hq/wake/issues/111)). CI's `docker-smoke` job already gates every release tag on "image builds + fake-adapter tick runs in-container", so tagged versions are pre-vetted and the post-deploy health check can stay thin (container up + tick-loop heartbeat). Residual risks CI can't see are host-specific: the locally built image drifting from CI's, migration against the real volume-mounted `.wake/` state, and credential/config issues — rollback + issue-filing covers exactly those; the manual script remains the operator's last-resort override | file new, [#111](https://github.com/atolis-hq/wake/issues/111) |

### Phase 3 — Throughput and capability (once the loop is trustworthy)

- **[#148](https://github.com/atolis-hq/wake/issues/148)** queue WIP limit and **[#122](https://github.com/atolis-hq/wake/issues/122)** parallel-execution control — protect budget from a flood of issues.
- **[#120](https://github.com/atolis-hq/wake/issues/120)** model override per stage — refine on cheap models, implement on capable ones; core budget lever.
- **E1** closed-issue observation + workspace cleanup (workspaces currently leak forever).
- **R8 full + R1** — unify the three runner adapters (~700 lines removed); by this point Wake should execute this itself as a sequence of PRs.
- **I1** named eligibility skip-reasons and **I5** `wake rebuild` — operability and the recovery path.
- **I4** independent review stage — a different runner reviews than implemented, raising PR quality so human approval gets faster/cheaper.
- Later: [#64](https://github.com/atolis-hq/wake/issues/64)/[#72](https://github.com/atolis-hq/wake/issues/72) declarative workflows, [#71](https://github.com/atolis-hq/wake/issues/71) Slack sink, [#82](https://github.com/atolis-hq/wake/issues/82) PR-activity source, [#83](https://github.com/atolis-hq/wake/issues/83) npm packaging.

### Explicitly deferred

- **[#176](https://github.com/atolis-hq/wake/issues/176) yolo mode** (end-to-end without approval) — conflicts with the human-approval constraint; revisit only when the operator relaxes it.
- **[#63](https://github.com/atolis-hq/wake/issues/63) prompt-injection hardening** — important before pointing Wake at repos with untrusted input; Wake's own repo is trusted, so it sequences after Phase 2.
- Large refactors (R1/R2/R3) before Phase 3 — too much review load per PR while human bandwidth is the bottleneck.

## 4. Execution model

**Assignment is dispatch.** Wake works only on issues assigned to it, and assigning an issue starts processing immediately — there is no queued-but-idle state after assignment. Filing and labeling issues is safe; assignment is pressing "go". Wake may self-select what to assign, but must do so one item at a time in phase order, assigning the next only when the current item reaches PR/blocked/done.

1. **File the missing issues** (marked "file new" above) with the report item pasted in as the spec — the report's problem/evidence/proposed-change format is already refine-quality input, which minimizes refine-stage token spend. Do **not** assign them at filing time.
2. **Assign in phase order, one at a time**; keep WIP at 1 until Phase 0 lands (the loop isn't yet safe under its own failures).
3. **Human drives Phase 0.1–0.4 directly if needed** — these are the bugs that would interrupt Wake working on itself. Everything after that, Wake should be picking up its own issues.
4. **Review cadence:** the operator's recurring job shrinks to (a) answering BLOCKED questions, (b) reviewing PRs. Each phase completed makes both cheaper.

## 5. Success criteria for "no longer needs help"

- A week of resident-loop operation with zero manual restarts or state-file surgery.
- Quota exhaustion results in pause → fallback/rotate → resume, never a failure comment loop.
- Every BLOCKED question demonstrably reaches GitHub (outbox confirms delivery).
- Wake has merged ≥5 self-improvement PRs where the human's only involvement was review/approve.
- Merged changes reach the running container without the operator running the update script (safe-stop → rebuild → health-check → rollback-on-failure, unattended).
