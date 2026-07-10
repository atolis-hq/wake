# Spec: Wake Control-Plane UI

**Status:** draft for review
**Date:** 2026-07-11
**Scope:** a small, mostly read-only web UI hosted in the sandbox container alongside the runner, giving operators visibility into the Wake home (events, projections, runs, config, locks) plus a handful of high-value, durably-mediated mutations.

---

## 1. Purpose and principles

Wake's durable state is already fully inspectable — it's plain JSON under the Wake home. What's missing is the *joined view*: "what is Wake doing right now, what is each work item waiting on, and why hasn't X been picked up?" Today answering those questions means reading `state/*.json`, `runs/*.json`, and grepping `events/*.jsonl` by hand.

Principles, in priority order:

1. **The UI is a sidecar, not a participant.** It reads the same files the tick reads and writes nothing the control plane doesn't already understand. It never calls into a running Wake process, holds no state of its own, and can be killed at any time with zero effect on the loop.
2. **Mutations go through durable state only.** Every write the UI performs must be something a crash/restart-safe tick would naturally observe: a file the policy already reads (`PAUSE`, `ledger.json`, the tick lock) or an event appended to the log that the projection fold understands. No in-memory signaling, no bypassing the event model.
3. **Read-only by default, mutations behind explicit affordances.** Every mutation is a deliberate button with a confirmation and a recorded operator event — never inline editing.
4. **Boring technology.** One small Node HTTP process, no database (the Wake home *is* the database), no build-step-heavy frontend. It should be reviewable in one sitting, like the rest of Wake.
5. **Workflow-agnostic.** Wake's stage set is becoming configurable (arbitrary stages, potentially multiple workflows selected per ticket). The UI must not hardcode any stage name, stage order, or stage count anywhere — every stage the UI shows is read from config (workflow definitions) or observed in the data (projections, stage history), and an unknown stage must render as gracefully as a known one. Grouping and prioritization are built on *derived item conditions* (§4.2) that hold for any workflow, with stage displayed as data on the item rather than structure of the page.

## 2. Deployment and architecture

- **Process:** a single Node service (`wake ui` subcommand, or `npm run ui`) started in the sandbox container next to the resident loop. It serves a static single-page frontend and a JSON API from the same port.
- **Data access:** reads the Wake home directly from the shared volume (`--wake-root`, same flag semantics as `tick`/`start`). Reuses the existing read paths: `createStateStore` readers, `domain/schema.ts` zod parsers, and `lib/lock.ts` metadata reading. It must not import anything that mutates state except the specific mutation handlers in §6.
- **Freshness:** polling, not file-watching, for v1. The API reads from disk per request (with a short in-process cache, ~2s, to avoid re-parsing the event log on every keystroke). The frontend polls active views every 5–10s. SSE/live-tail is a v2 nicety, not required.
- **Network exposure:** binds `127.0.0.1` inside the container by default. Operators reach it via an explicit `docker run -p` / compose mapping added to the sandbox scaffold. A shared-secret token (env `WAKE_UI_TOKEN`, sent as a bearer header / cookie) is required whenever the bind address is non-loopback; without a token the server refuses non-loopback binds. No user accounts, no roles — this is a single-operator tool.
- **Resilience to bad data:** every file read tolerates missing, truncated, or schema-invalid JSON (this is real: the state store today swallows corruption — report items S5/E11). Invalid files are *surfaced*, not hidden: the health view lists unreadable files rather than silently dropping them, which makes the UI a corruption detector the CLI currently lacks.
- **Config surface change:** `wake init` scaffolding gains an optional `ui` block (`{ enabled, port, token? }`) and the sandbox docs gain the port mapping. Per repo policy, `README.md` / `docs/configuration.md` must be updated in the same change.

## 3. Data sources (all existing, no new state)

| Source | Path | Feeds |
|---|---|---|
| Config | `config.json` | Config view, routing table, policy display |
| Pause file | `PAUSE` | Status bar, pause control |
| Ledger | `ledger.json` (`pausedUntil`) | Status bar, pause control |
| Tick lock | `locks/tick.lock` | Lock status, stale-lock action |
| Projections | `state/<repo>/<issue>.json` | Kanban board, item detail |
| Run records | `runs/run-*.json` | Runs view, item detail, metrics |
| Event log | `events/<date>.jsonl` (+ `events-by-id/`) | Activity feed, item timeline |
| Source poll state | `sources/<source>/<key>.json` | Health view (poll freshness per repo) |
| Workspaces | `workspaces/**`, `repos/**` (directory listing only) | Workspaces view, orphan detection |
| Logs | `logs/<date>.log` | Raw log tail (secondary) |

## 4. Views

### 4.1 Status bar (always visible)

The one-glance answer to "is Wake alive and doing the right thing":

- **Loop state:** derived, in order: `paused` (PAUSE file present or `pausedUntil` in the future — show which, and until when) → `ticking` (lock currently held; show holder pid and age) → `idle` (lock free; show time since the last event of any kind).
- **Last activity:** timestamp + type of the most recent event, and the most recent run's outcome (`repo#issue action → sentinel`).
- **Source freshness:** worst-case `lastSuccessfulPollAt` across configured repos, amber above 3× the scheduler interval, red above 10×.
- **Counters:** items per condition (mirrors the board: needs-attention / active / ready / waiting / stalled), runs today, failures today.

### 4.2 Board (default view) — conditions, not stages

A classic kanban assumes one fixed, ordered stage pipeline. Wake's workflows are becoming configurable — arbitrary stages, possibly a different workflow per ticket — so stage cannot be the board's structure. Instead, the board's columns are **derived item conditions**: a small, closed set of answers to "what is this item waiting for right now?" that can be computed for *any* workflow from control-plane semantics alone (run records, sentinels, eligibility, and whether the policy has any next action). Stage is shown as a chip on the card, not as a column.

The conditions, in operator-priority order (left to right):

| Column | Meaning | Derivation (workflow-independent) |
|---|---|---|
| **Needs human** | Wake is explicitly waiting on a person | last sentinel `BLOCKED` or `AWAITING_APPROVAL`, with no unhandled human reply yet |
| **Active** | a run is in flight right now | a `running` run record exists for the item |
| **Ready** | Wake will act on the next tick | eligible + policy yields a next action + `needsWakeAction` true |
| **Waiting** | healthy but nothing to do yet | not eligible or nothing actionable, with a *named reason* (missing required label, ignored label, human reply already handled, quota-paused…) |
| **Stalled** | not terminal, yet no possible path forward | not terminal, not eligible-for-human-input, and no action can ever fire from the current state — the generic form of the report's E8/E14 dead-ends, detectable without knowing the workflow |
| **Finished** | terminal | terminal stage per the item's workflow definition (or issue closed); collapsed by default |

Notes on the two subtle columns:

- **Stalled is the board's reason to exist.** It is computed structurally — "no transition out of here can occur without operator intervention" — which stays correct no matter how many stages a workflow has. Every stranded-state bug found in the production logs would have been a visible card in this column.
- **Waiting always carries a reason.** The policy engine currently returns bare booleans; the UI re-derives reasons with the same rules until report item I1 (named policy predicates) lands, after which it consumes them directly. The spec prefers that ordering but does not depend on it.

Each card shows:

- `repo#number` + title (links to item detail; external-link icon to the ticket URL)
- **stage chip**: the current stage name as data, plus workflow name when multiple workflows are configured; if the item's workflow definition is known, a compact progress dots strip (`● ● ○ ○`, k-of-n positional, rendered from the definition's stage order) — omitted entirely when the workflow is unknown, never guessed
- time in current condition and time in current stage (both from event/stage history)
- last run outcome chip: sentinel + `envelope: degraded` badge + `failureClass` when failed
- small icons: session resumable, workspace attached, unhandled human comment present

Grouping and filters: filter by repo, workflow, stage (values populated dynamically from config ∪ observed), "needs attention" preset (Needs human + Stalled), free-text on title. When a filter narrows the board to a **single workflow**, the operator can switch to an optional **stage view**: the same cards re-columned by that workflow's stages in definition order. This gives back the familiar kanban *only* where a fixed pipeline actually exists, as a lens rather than an assumption; it is unavailable (not degraded) for mixed-workflow selections.

Stages that exist in projections but not in any configured workflow (renamed/removed stages, hand-applied labels) are rendered with an "unknown stage" marker and surface in the health view — historical data must never crash or vanish from the board.

### 4.3 Item detail (drawer or page)

Everything Wake knows about one work item, joined:

- **Header:** issue snapshot (title, labels with `wake:*` labels highlighted, assignees, state, link), current stage, waiting-on indicator.
- **Timeline:** merged, time-ordered view of `stageHistory` entries and this item's events (from `recentEventIds` plus a date-file scan filtered by `workItemKey`), each row: time, type, reason/sentinel, expandable raw envelope JSON.
- **Runs:** this item's run records — action, status, sentinel, envelope structured/degraded, failureClass, duration, tokens, model, runner/tier, run id — with the full `summary` body expandable (this is where operators read the agent's actual question on a blocked run).
- **Session:** session id + CLI when present, and the exact local resume command (`claude --resume …` etc.) with a copy button, plus the workspace path. If the workspace path is the shared canonical clone (report E7), show it as "shared clone — do not resume here" rather than offering the cd hint.
- **Context:** the projection `context` bag (lastHandledCommentId, lastRunSentinel, pendingApprovalAction, …) shown as-is — this is the debugging goldmine for "why won't it retry".
- **Raw:** toggle to the full projection JSON.

### 4.4 Activity feed

A reverse-chronological tail of the event log (last N days, default 2):

- Row: time, direction badge (inbound/outbound/internal), `sourceEventType`, work item key (links to detail), one-line payload summary (sentinel, label names, comment kind, reason).
- Filters: direction, event type, work item, repo, date.
- **Anomaly chips** inline: duplicate event id (seen in production), `envelope: degraded`, delivery intents with no matching confirmation event (the dead-letter signal from report E5 — the feed computes intent→confirmation pairing per `intentEventId` and flags unconfirmed intents older than a grace window).

### 4.5 Runs and metrics

- Table of all run records (sortable, filterable by status/action/runner/repo), same columns as item detail plus issue link.
- Summary tiles over a selectable window (day/week/all): total runs; success/blocked/awaiting/failed split; **degraded-envelope rate** (production baseline: 35% — this number on a dashboard is the forcing function for fixing it); failure breakdown by `failureClass`; tokens and (once report R8 lands) cost per day and per runner; median duration per action.
- "Repeat offenders": items with ≥3 runs for the same action, surfacing retry loops like the observed 5-runs-in-5-minutes quota incident.

### 4.6 Config view

- The effective config (post-zod-defaults, i.e. what `loadWakeConfig` returns), pretty-printed, read-only.
- A rendered **routing table**: stage → pinned runner or tier → resolved runner entry → model per action → timeout / maxTurns source. This answers "which model will implement use?" without mentally executing `resolveRunnerRouting`.
- Redaction: no secrets currently live in `config.json` (tokens come from env), but the renderer must still mask any key matching `token|secret|key|password` defensively.
- Unknown/dead keys: flag config keys the loaded schema doesn't recognize. (Known-dead keys like `lookbackMs` / `postStatusComments` are a code problem, not a UI problem, but flagging unknowns catches operator typos.)

### 4.7 Health view

- **Tick lock:** present/absent, holder pid, pid-alive check, age vs. staleness threshold; stale locks highlighted with the release action (§6).
- **Pause state:** PAUSE file, `pausedUntil`, with controls (§6).
- **Source polling:** per configured repo, `lastSuccessfulPollAt` and staleness.
- **Storage:** per-directory item counts and sizes (events, runs, state, workspaces); run-record count growth (the tick lists all run records every tick, so this number is operationally relevant).
- **Integrity:** unreadable/invalid JSON files by path; projections whose `workspacePath` no longer exists on disk; workspace directories with no matching projection (orphans); duplicate event ids detected in the loaded window.

### 4.8 Workspaces view (secondary)

List of `workspaces/<repo>/<issue>` directories joined against projections: issue state/stage, workspace size, git branch (cheap `git -C … rev-parse --abbrev-ref HEAD`), orphan/leak flags. Cleanup action per row (§6). The canonical clones under `repos/` are listed read-only, clearly separated, with no cleanup affordance.

## 5. API (JSON, versioned under `/api/v1`)

Read endpoints (all GET, all cacheable ~2s):

```
/status                         → status-bar payload
/board                          → cards grouped by derived condition; stage/workflow as card attributes
/workflows                      → workflow definitions from config (stage lists, order, terminal flags) ∪ observed-but-unconfigured stages
/items/:repo/:number            → projection + joined runs + timeline
/items/:repo/:number/events     → full event list for the work item
/runs?status=&action=&repo=     → run records (paged)
/metrics?window=7d              → aggregate tiles
/events?since=&type=&direction= → activity feed (paged)
/config                         → effective config (redacted) + routing table
/health                         → locks, pause, sources, storage, integrity
/workspaces                     → workspace join
```

Mutation endpoints (POST/DELETE, token-gated when non-loopback, all idempotent):

```
POST   /pause                  { untilIso? }     → create PAUSE file or set ledger.pausedUntil
DELETE /pause                                    → remove PAUSE + clear pausedUntil
POST   /locks/tick/release                       → break the tick lock iff stale (re-verified server-side)
POST   /items/:repo/:number/requeue  { stage }   → append operator requeue event (see §6)
POST   /items/:repo/:number/nudge                → append operator nudge event (see §6)
POST   /workspaces/:repo/:number/cleanup         → append cleanup-requested event / direct cleanup (see §6)
```

Every mutation response includes what was written (file path or event id) so the operator can verify against the raw log.

## 6. Mutations (the deliberate short list)

Ordered by value. Everything else stays read-only in v1.

1. **Pause / resume** — *no new mechanics.* Pause-now writes the `PAUSE` file; pause-until writes `ledger.pausedUntil` (note: `pausedUntil` is currently never read by `isPaused()` — report E13 wires it; this spec depends on that fix or ships the same two-line change). Resume deletes both. Value: the safe "stop the world" button during incidents, and the manual fallback for quota exhaustion until E13's automatic backoff lands.

2. **Release stale tick lock** — deletes `locks/tick.lock` only after re-running the same staleness logic as `lib/lock.ts` server-side (age past threshold *or* holder pid dead) at the moment of the request. Refuses if the lock looks live. Value: today a wedged lock means shelling into the container; this makes the recovery observable and safe.

3. **Requeue to stage** — appends an operator event to the log, e.g.:

   ```json
   { "sourceEventType": "wake.operator.requeue",
     "direction": "internal",
     "payload": { "targetStage": "queue", "operator": "ui", "note": "…" } }
   ```

   with a small new branch in `projection-updater` that folds it (set stage, append stageHistory with reason `operator:requeue`, clear `lastRunSentinel` so `needsWakeAction` can fire). **This is the only mutation requiring a core change**, and it is worth it: it is the manual escape hatch for every stranded-state finding in the report (E8, E14, legacy `blockedFromAction` items) — an operator seeing a Stalled card moves it back to an actionable stage instead of hand-editing labels on the ticket and hoping label-sync cooperates. Allowed targets are **derived from the item's workflow definition, never hardcoded**: any stage of that workflow that has an action or entry semantics (i.e. a stage the policy could act from), excluding transient in-run stages and terminal stages. When the item's workflow is unknown (unconfigured/legacy stage), the target list falls back to the configured workflows' entry stages, and the UI says so.

4. **Nudge (clear failed latch)** — a narrower cousin of requeue: appends `wake.operator.nudge` which folds to clearing `lastRunSentinel`/`lastHandledCommentId` without moving stage, making the item actionable on the next tick with its existing stage and session. Value: retry-after-transient-failure without losing a resumable session. (Skippable in v1 if requeue proves sufficient.)

5. **Workspace cleanup** — for items that are `done`/`failed`/closed with a per-issue workspace still on disk: triggers the existing `cleanupWorkspace` path and appends the existing `wake.workspace.cleaned` event so the projection updates. Server-side guard: refuse any path outside `workspaces/` (same rule as `isPerIssueWorkspacePath`). Value: the leak mitigation until report E1 makes automatic cleanup reachable.

Explicit **non-mutations** (rejected for v1): approving work (`/approved` must stay a ticket-channel act so the audit trail lives with the work item — the UI links to the ticket instead), editing config (operators edit `config.json`; the UI only displays), retrying a specific run with different parameters (that's routing policy, owned by config), and anything that posts to the external tracker.

## 7. Non-goals

- Not a multi-user product: no auth beyond the shared token, no audit log beyond the operator events themselves (which *are* the audit log).
- Not a log browser for agent transcripts: run `summary`/`stdout` stored in run records is shown, but full session transcripts belong to the agent CLIs.
- Not real-time: seconds-stale is fine everywhere.
- Not a write path to GitHub or any external system.

## 8. Phasing

- **v0 (read-only, ~a few days):** status bar, condition board, item detail, activity feed, config view, health view. Zero core changes. Immediately answers "why is this stuck" for every failure mode documented in the improvement report. The single-workflow stage view (the kanban lens) can trail in v0.1 — the condition board carries all the operational value.
- **v1 (mutations):** pause/resume (with the E13 `pausedUntil` wiring), stale-lock release, workspace cleanup. One small core change: none.
- **v1.1 (operator events):** requeue + nudge, with the `projection-updater` fold branch and tests through the fake adapters.
- **v2 (nice-to-have):** SSE live tail, dead-letter intent pairing surfaced as a first-class queue (pairs with report E5's outbox), metrics history beyond what the raw logs support.

## 9. Open questions

1. Should the UI process be supervised by the same container entrypoint as the resident loop, or started on demand? (Recommendation: same entrypoint, it's stateless and cheap.)
2. Frontend approach: server-rendered HTML with a sprinkle of vanilla JS keeps the repo dependency-free; a small Preact/htm no-build setup is the ceiling. Recommendation: whichever the team can review comfortably — no bundler either way.
3. Does `wake.operator.requeue` need label sync back to the tracker (append the same `wake.labels.requested` intent the tick would produce)? Recommendation: yes — otherwise label-wins reconciliation can immediately undo the requeue on the next poll; this makes the tracker-sync behavior consistent with every other transition.
