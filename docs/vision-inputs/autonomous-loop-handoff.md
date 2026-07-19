> [!NOTE]
> **This is not the accepted plan.** This document is an early-thinking input: a
> detailed but pre-vision design sketch for a scheduler-driven loop. It is kept
> because much of its mechanism is reused, but it must not be treated as the
> final design. Where it conflicts with [`../vision.md`](../vision.md) or
> [`../implementation.md`](../implementation.md), those documents win. Known
> divergences from the accepted plan: timing is owned by a resident Node control
> plane, **not** Windows Task Scheduler (supersedes D1/§5 step 5); stages may
> **resume** an existing session rather than always spawning a fresh process
> (refines D1); per-issue **folders** are an accepted isolation alternative to
> worktrees; and proactive budget metering is a post-MVP concern (refines D2).

# Autonomous Task Loop — Implementation Hand-off

**Audience:** an implementing model (Sonnet/Opus/Haiku) in Claude Code.
**Goal:** background agent cycle on a $20/mo Claude Pro plan that picks up tasks,
runs them to completion (PR) or raises questions, and pauses itself when usage
budget is exhausted — resuming automatically when limits reset.

---

## Design decisions already made — do not re-litigate

These come from how Claude Code and Pro-plan limits actually work. Implement as specified.

### D1. Scheduler-driven, one task per invocation (NOT a long-running loop)

Use Windows Task Scheduler (this machine is Windows 11) firing a dispatcher
script every 30 minutes. Each firing runs **at most one task** via headless mode:

```
claude -p "<runner prompt>" --output-format json --model <model> \
  --permission-mode acceptEdits --add-dir <worktree>
```

Why not a persistent loop / stop-hooks / `/loop`: a fresh `claude -p` process per
task means state lives in files and git (not in a fragile conversation), cost is
bounded per run, crashes are self-healing (next tick just runs), and "pausing"
is trivial — the dispatcher just declines to invoke. This is the single most
important architectural choice; everything else hangs off it.

### D2. Budget enforcement: fail-and-backoff + self-imposed cap. Do NOT try to query remaining quota.

There is **no supported API to read remaining Pro-plan allowance**. Do not build
around scraping /usage or OAuth endpoints — they're unstable. Instead, two layers:

1. **Reactive:** when `claude -p` fails, inspect stderr/JSON for a usage-limit
   message. These messages include a reset time. Write `{"pausedUntil": <ts>}`
   to the ledger; dispatcher exits immediately until that time passes. If no
   reset time can be parsed, back off a fixed 5 hours (the session-window length).
2. **Proactive (the "% of weekly allowance" control):** every successful
   `--output-format json` result includes `total_cost_usd` and token usage.
   On a subscription this is _notional_, but it is a faithful **proportional
   proxy** for allowance consumption. Keep a rolling ledger
   (`.autoloop/ledger.json`): per-run cost, per-ISO-week totals. Config value
   `weeklyBudgetUsd` (start at ~$4–5 notional for a Pro plan and tune) and
   `backgroundSharePct` (e.g. 50%). When week-to-date background spend ≥
   budget × share, the dispatcher pauses until the next Monday-ish reset
   (track the week the user's limit actually resets; configurable anchor).

3. **Interactive-protection window:** config `quietHours` (e.g. only run
   00:00–07:00 plus a lunchtime slot). Pro limits are shared between manual and
   background use in the same 5-hour windows — running the loop overnight is
   the cheapest way to stop it starving daytime manual sessions. Additionally:
   skip the tick if a `claude` interactive process is currently running
   (check process list) — never compete with the human.

### D3. Task queue = directory of markdown files, states = directories

```
.autoloop/
  config.json          # budget, models, quiet hours, repo allowlist
  ledger.json          # spend + pause state
  tasks/
    queue/     *.md    # ready to run (priority-ordered by filename prefix: 10-, 20-)
    active/            # dispatcher moves file here while running (crash-safe lock)
    blocked/           # agent had questions; human edits file, moves back to queue/
    done/              # completed, PR link appended
    failed/            # 3 strikes (see D6)
```

Task file format (frontmatter + body). **Task quality is the #1 determinant of
autonomous success** — enforce this template, reject queue files missing
acceptance criteria:

```markdown
---
title: Add branch filter to list_nodes MCP tool
model: sonnet # haiku | sonnet | opus — human sets; default sonnet
maxAttempts: 3
repo: C:\git\atolis-hq\corum
---

## Context

(why, links to ADRs/files)

## Acceptance criteria

- [ ] concrete, verifiable outcomes
- [ ] tests pass: `npm test`

## Out of scope

(explicit non-goals — prevents scope creep, the top autonomous failure mode)
```

### D4. The runner prompt (what `claude -p` is told)

One fixed prompt template, parameterized by task file path. Core contract:

```
You are an autonomous worker. Read the task file at <path>.
You are in a dedicated git worktree on branch <branch>. Rules:
1. If the task is ambiguous or acceptance criteria can't be met as written:
   append a "## Questions" section to the task file listing specific,
   answerable questions, then STOP. Print exactly BLOCKED as your last line.
2. Otherwise implement it. Run the project's tests. Do not claim success
   without passing test output.
3. Commit with a descriptive message, push the branch, open a PR with
   `gh pr create --fill`, append the PR URL to the task file under
   "## Result". Print exactly DONE as your last line.
4. Never push to main. Never force-push. Stay within the task's repo.
5. If you hit an unrecoverable error, print exactly FAILED and a one-line reason.
```

Dispatcher routes on the sentinel (DONE/BLOCKED/FAILED found in the JSON
`result` field) → moves the task file to done/blocked/failed and records cost.

### D5. Isolation and safety rails

- Every run gets a fresh `git worktree add` off main, branch `autoloop/<task-slug>`;
  worktree removed after the run. Human review happens at the PR — the loop
  never merges.
- Use `--permission-mode acceptEdits` plus a project `.claude/settings.json`
  allowlist (npm test/build, git, gh pr create). Avoid
  `--dangerously-skip-permissions` unless prompts prove blocking; if used, it
  MUST be combined with the worktree isolation and a deny-list on push/merge to main.
- Dispatcher enforces a hard wall-clock timeout per run (e.g. 20 min) — kill
  the process, count as a failed attempt.

### D6. Failure and question loop

- `maxAttempts` (default 3): each FAILED/timeout increments a counter in the
  frontmatter; on the 3rd, move to failed/ — never burn budget retrying forever.
- BLOCKED tasks are the human interface: you answer the questions inline in the
  file and move it back to queue/. Optionally the dispatcher posts a Windows
  toast / appends to a NEEDS-INPUT.md summary so blocked items are visible.
- Everything the dispatcher does goes to `.autoloop/log/<date>.log`.

### D7. Model routing

Human sets `model:` per task; default **sonnet**. Use **haiku** for mechanical
tasks (renames, doc updates, test backfills) — it's dramatically cheaper per
run and extends the weekly budget. Reserve **opus** for tasks explicitly
flagged; on a $20 plan an opus run can eat a large fraction of a 5-hour window.
Do NOT auto-escalate models on retry — a failed sonnet attempt usually means
the task spec is bad, not that the model is too small; that's what blocked/ is for.

---

## Implementation order (small, testable increments)

1. **Dispatcher skeleton** (PowerShell, `.autoloop/dispatcher.ps1`): read config,
   pick top queue file, move to active/, run `claude -p` with a trivial prompt,
   parse JSON result, move file, write ledger entry. Test with a dummy task.
2. **Budget layer:** ledger accounting, weekly cap check, pausedUntil handling,
   quiet hours, interactive-process check.
3. **Worktree + PR flow:** worktree create/cleanup, runner prompt as in D4,
   sentinel routing, `gh` auth assumed pre-configured.
4. **Limit-error parsing:** deliberately probe what a limit failure looks like
   in `--output-format json` stderr/exit code and write the parser against the
   real message (don't guess the format — capture one first).
5. **Task Scheduler registration:** `schtasks` or `Register-ScheduledTask`,
   every 30 min, run whether user logged in or not, no window.
6. **Niceties (optional):** toast on BLOCKED, NEEDS-INPUT.md digest, `autoloop
status` subcommand printing queue depth + week-to-date spend vs budget.

## Acceptance test for the whole system

Put two tasks in queue/ (one well-specified, one deliberately ambiguous). Set
weekly budget artificially low. Verify: well-specified task → PR opened, file
in done/ with URL; ambiguous task → questions written, file in blocked/;
third dispatcher tick → pauses on budget with a clear log line; after resetting
the ledger week → resumes.

---

# Amendment 1 — GitHub Issues as the queue + two-stage pipeline

This amendment supersedes D3's directory queue and refines D4/D7. The budget,
scheduling, isolation, and failure rails (D1, D2, D5, D6) are unchanged.

### A1. Queue = GitHub Issues, states = labels

Replace `.autoloop/tasks/` with issues on the repo, driven via `gh` (already
authenticated). Label state machine:

```
autoloop:queue → autoloop:active → autoloop:blocked | autoloop:done | autoloop:failed
                 (plus autoloop:refined — see A2)
```

- Dispatcher picks work with
  `gh issue list --label autoloop:refined --json number,title --limit 1`
  (oldest first; use an `autoloop:priority` label to jump the line).
- The issue **body** is the task spec (same template: acceptance criteria,
  out-of-scope). The worker reads it via `gh issue view <n>`.
- **Questions become issue comments**, not file edits. Worker posts questions
  with `gh issue comment`, dispatcher applies `autoloop:blocked`.
- **Unblocking is automatic:** each tick, for every blocked issue, check
  whether the most recent comment is from the human (not the bot/worker
  account or the worker's marker). If so → relabel `autoloop:queue`. You
  answer from the GitHub mobile app in bed; the overnight run picks it up.
- PRs reference `Closes #<n>`; on DONE the dispatcher comments the PR URL and
  labels `autoloop:done` (the merge itself closes the issue).

Why this is the major uplift: you get a phone-native interface (GitHub mobile
push notifications on @mentions/comments), a full audit trail, zero custom UI,
and task capture from anywhere — you file an issue from your phone and it's in
the queue. Note: keep the runner **local** (`claude -p` on this machine).
Do NOT use the Claude GitHub Action as the executor — it bills API tokens
separately from the Pro subscription. GitHub is the interface; the $20 plan
does the work.

Have the worker @mention the human's GitHub username in every questions
comment so GitHub mobile pushes a notification.

### A2. Two-stage pipeline: haiku refinement, then sonnet implementation

**Stage 1 — Refine (haiku, batched):** a tick may take up to the 3 oldest
`autoloop:queue` issues and run ONE haiku pass over each (small, cheap, strict
`--max-turns` cap ~10). The refiner:

- rewrites the body into the full spec template (acceptance criteria,
  files likely touched, out-of-scope),
- if anything is ambiguous, posts the questions comment and labels
  `autoloop:blocked` **now**, before any expensive run,
- otherwise labels `autoloop:refined`.

**Stage 2 — Implement (sonnet, strictly one per tick, to completion):** only
`autoloop:refined` issues are eligible. Same runner contract as D4.

This answers "one-by-one vs refine top X": **both, split by cost.** Refinement
is batched and cheap so your answers to questions arrive while implementation
proceeds on already-ready tasks — the pipeline never stalls waiting on you.
Implementation stays strictly serial: parallel expensive runs on a Pro plan
just race each other into the same 5-hour window and produce conflicting PRs.

Token economics (why this ordering matters): the most expensive failure mode
is a sonnet run that burns 15 minutes and then discovers the task was
ambiguous. Stage 1 makes ambiguity cost a haiku triage instead of a sonnet
implementation — this is the largest single token saving available.

### A3. Additional token savers (cheap to implement, do all of them)

- `--max-turns` on every invocation: ~10 for refinement, ~50 for implementation.
  Hard cap on runaway runs; a run that hits the cap counts as FAILED.
- Keep a separate minimal system-prompt file for the worker (`--append-system-prompt`)
  instead of relying on a large CLAUDE.md; the worker doesn't need the
  interactive-session conventions.
- On retry after FAILED, have the dispatcher include the previous run's final
  error line in the prompt (one line, from the ledger) — prevents the retry
  from rediscovering the same dead end, without dragging in a whole transcript.
- Refinement comments, not refinement re-runs: once an issue is `autoloop:refined`,
  never re-refine it; human edits to the body pass through as-is.

### A4. Out of scope for this amendment

- Claude mobile app / claude.ai as the interface: it cannot drive the local
  machine's headless runs. (Claude Code's interactive `/remote-control` exists
  for steering a _live local session_ from the mobile app — useful for manual
  work, irrelevant to the scheduled loop.)
- Hooks/webhooks reacting to GitHub events in real time: nice, but the 30-min
  poll via `gh` is simpler and the loop is latency-insensitive. Revisit only
  if polling ever becomes the bottleneck.

### Revised acceptance test

File three issues from the GitHub mobile app: one well-specified, one vague,
one vague-then-answered. Verify: refiner labels the first `autoloop:refined`
and sonnet ships a PR closing it; the vague one gets a questions comment +
`autoloop:blocked` and a push notification; after you reply by comment, the
next tick relabels it to queue and it flows through; ledger shows the
refinement passes cost a small fraction of the implementation pass.

---

# Amendment 2 — Lean learning loop

Goal: the system gets better over time without dedicated "reflection" runs.
Three rules keep it near-free: (1) lessons are captured **inside runs that are
already happening**, (2) the lessons file is **hard-capped in size** so the
per-run injection cost is bounded and constant, (3) the only dedicated
learning run is a **weekly haiku distillation** (~one cheap run/week).

### L1. Capture: one line per run, piggybacked

Extend the D4 runner contract with one clause:

```
6. Before printing your final sentinel, IF (and only if) you hit something
   non-obvious that would have saved you time to know in advance — a repo
   gotcha, a command that fails, a convention, a flaky test — append ONE line
   to .autoloop/LESSONS.md in the form:
   - [<date>] <lesson in one sentence>
   Most runs should append nothing. Never append generic advice.
```

The refiner (Stage 1) gets the same clause with lessons about _specs_
("tasks touching src/loader/ need an ADR reference or they get blocked").
Cost: a few dozen output tokens, only on runs that learned something.

### L2. Apply: inject the capped file into every prompt

The dispatcher concatenates `LESSONS.md` into the worker's
`--append-system-prompt` (after the minimal system prompt from A3). Hard cap:
**40 lines / ~2 KB**. If the file exceeds the cap, the dispatcher truncates
oldest-first and flags it for distillation. Because the cap is constant, the
learning loop's steady-state cost per run is fixed and small — it cannot grow
into a token sink.

### L3. Distill: one haiku run per week

A weekly scheduled tick (piggyback on the existing scheduler; run only if
LESSONS.md changed since last distill) runs haiku with `--max-turns 5`:
merge duplicates, drop anything stale or generic, rewrite for brevity,
keep the file under 30 lines, commit the result. That's the entire dedicated
learning spend: ~one triage-sized run per week.

### L4. The richest free signal: PR review comments

When the human reviews an autoloop PR, corrections in review comments are
higher-quality lessons than anything the worker self-reports. Fold this into
the weekly distill run (same single run, no extra invocation): before
distilling, it pulls review comments from autoloop PRs merged/closed that week
(`gh pr list --search "head:autoloop" --state merged` + `gh api` for review
comments) and extracts recurring corrections into LESSONS.md. If you rejected
a PR, say why in a review comment — that sentence becomes a rule next week.

### L5. What NOT to build

- No per-run reflection/self-critique step — it roughly doubles cost for
  marginal benefit; the one-line rule captures most of the value.
- No embeddings/RAG over past transcripts — transcripts are gone by design
  (fresh process per run, D1) and that's a feature, not a gap.
- No unbounded memory: if a lesson matters permanently, the weekly distill
  should propose promoting it into CLAUDE.md or the task template via a normal
  autoloop issue — reviewed by the human like any other change. LESSONS.md is
  working memory; CLAUDE.md is the genome.

### Acceptance test

Seed LESSONS.md with a fake lesson ("tests must run with X flag"); verify the
next worker run visibly obeys it. Force a worker to hit a known gotcha; verify
exactly one line is appended. Overfill the file past 40 lines; verify the
dispatcher truncates and the weekly distill compresses it under 30. Leave a PR
review comment correcting a convention; verify the next distill turns it into
a lesson.

---

# Amendment 3 — Zero-LLM scheduled scripts

Everything below is plain PowerShell + `gh` + npm on the existing Task
Scheduler. No Claude invocation, zero allowance cost. Implement these as
separate small scripts (or dispatcher sub-steps) so they run even while the
loop is budget-paused. Ordered by impact.

### Tier 1 — directly saves LLM runs (highest impact)

1. **Baseline health gate (nightly + before every implementation tick).**
   Run `npm run build && npm test` on a clean checkout of main. If red, set
   `baselineBroken: true` in the ledger and skip all implementation ticks
   (refinement may continue). A worker debugging a pre-broken main is the
   purest possible waste of sonnet tokens. Auto-file a `autoloop:queue` issue
   "main is red: <first failing test>" so fixing it becomes the next task.
2. **Spec pre-flight validation (each tick, before refinement).** Regex-check
   new `autoloop:queue` issues for the required sections (`## Acceptance
criteria` with at least one checkbox, `## Out of scope`). Missing → comment
   a template with what's absent, label `autoloop:needs-spec`, @mention the
   human. Catches malformed tasks for free instead of spending a haiku run to
   discover the same thing.
3. **Unblock detection (each tick).** For every `autoloop:blocked` issue:
   `gh issue view <n> --json comments` — if the latest comment author is the
   human, relabel to `autoloop:queue`. (Already specified in A1; implement it
   as this standalone no-LLM step.)
4. **Deterministic issue generation (nightly).** Run the checks that already
   exist and file their findings as ready-made queue issues:
   `node dist/src/bin/corum.js lint` (graph warnings), `npm audit`,
   `npx tsc --noEmit` on stricter flags, dead-link check on docs/. Each new
   finding → one issue with the tool output pasted in as context. This feeds
   the queue with well-scoped, machine-specified tasks — the cheapest tasks
   the loop will ever run. Dedupe by title before filing.

### Tier 2 — keeps the loop healthy (prevents silent stalls)

5. **Stale-lock and orphan cleanup (each tick, first step).** Any issue in
   `autoloop:active` older than the run timeout → count as a failed attempt,
   relabel per D6. `git worktree prune` + delete `autoloop/*` worktree dirs
   with no matching active issue. Delete local+remote `autoloop/*` branches
   whose PR is merged/closed.
6. **Label/state reconciliation (nightly).** PR merged but issue not
   `autoloop:done` → fix label, comment the PR URL. Issue closed manually →
   clear autoloop labels. Keeps the state machine trustworthy so the
   dispatcher never acts on lies.
7. **Ledger integrity + budget rollover (nightly).** Recompute week-to-date
   totals from raw per-run entries (guards against a crashed tick corrupting
   the summary), roll the week on the configured anchor, clear expired
   `pausedUntil`.

### Tier 3 — keeps you informed (zero effort on your side)

8. **Morning digest (07:00 daily).** One comment on a pinned "autoloop status"
   issue (so it lands as a GitHub mobile notification): PRs awaiting review,
   blocked issues awaiting answers, queue depth, week-to-date spend vs budget,
   baseline status. One glance over coffee replaces checking anything manually.
9. **Log rotation + run archive (weekly).** Zip `.autoloop/log/` older than
   14 days; append each run's sentinel/cost/duration to a `runs.csv` for
   trend-spotting (e.g. rising FAILED rate → task specs degrading).

### Non-goals

- No auto-merge of PRs, however green — human review is the only quality gate
  the system has (D5).
- No scripted retry storms: retries remain attempt-counted via D6 only.

### Acceptance test

Break a test on main → verify implementation ticks skip, a "main is red"
issue appears, and refinement still runs. File an issue missing acceptance
criteria → verify it gets the template comment + `autoloop:needs-spec` without
any LLM run. Kill a worker mid-run → verify next tick releases the lock,
prunes the worktree, and increments attempts. Check the 07:00 digest lists all
of the above.

---

# Amendment 4 — Human jump-in and event-driven triggering

### J1. Jumping into a run's conversation: record session IDs

Every `claude -p --output-format json` result includes a `session_id`, and
headless sessions are resumable. The dispatcher MUST:

- capture `session_id` from every run's JSON output,
- store it in the ledger entry, and
- include it in the issue comment it posts on BLOCKED/FAILED
  ("session: `<id>`").

Then jumping in is one command at the machine:

```
claude --resume <session_id>
```

This reopens the worker's full conversation interactively — you see exactly
what it saw, and can steer, ask "why did you do X", or finish the task by
hand with full context. Use it for **post-mortems on FAILED runs and odd
PRs** — it's the single highest-value debugging affordance and costs nothing
to record.

Guidance on when NOT to resume: for BLOCKED tasks, answering the issue
comment is almost always better than resuming — the fresh-context re-run
(D1) with your answer folded into the spec is cheaper and cleaner than
reviving a long transcript. Resume to _understand_; comment to _unblock_.

**Interrupting an in-flight run:** don't inject into a running headless
process. Instead: a `.autoloop/PAUSE` flag file — the dispatcher checks it
before starting any run (touch it to stop new work instantly; delete to
resume). If a run must die now, kill the process; the stale-lock cleanup
(Amendment 3 §5) recovers it as a failed attempt on the next tick.

**Remote jump-in (from phone, no PC access):** comment `/pause` or `/resume`
on the pinned status issue; the trigger poll (J2) toggles the PAUSE flag.
For interactively steering a live session from the Claude mobile app,
`/remote-control` exists — but it applies to sessions you start manually,
not the scheduled headless runs; treat it as out of scope for the loop.

### J2. Event-driven via two-tier polling — do NOT build webhooks

A true GitHub webhook needs your machine reachable from the internet
(tunnel/funnel + endpoint + auth). That's real attack surface and real
complexity for a loop that tolerates minutes of latency. Get 95% of
event-driven behavior with a second, cheaper timer:

- **Trigger poll — every 2 minutes, no LLM, one API call:**
  `gh api search/issues` (or `gh issue list --json comments` on labeled
  issues) for comments newer than the last-seen timestamp in the ledger.
  It reacts to three commands (comment these from GitHub mobile):
  - `/actionnow` on an issue → label it `autoloop:priority` and fire a full
    dispatcher tick immediately, with that issue first in line.
  - `/pause` / `/resume` on the status issue → toggle the PAUSE flag.
  - (a fresh human comment on a blocked issue also counts — unblock it and,
    if `/actionnow` accompanies it, tick immediately.)
- **Full tick — every 30 minutes** as before (the baseline heartbeat; also
  the fallback if the trigger poll ever breaks).

Rules for `/actionnow`:

- Only honored from the repo-owner account (check comment author) — anyone
  else who can comment on your issues must not be able to spend your budget.
- Overrides **quiet hours** (an explicit human request beats the schedule)
  but never overrides a **usage-limit pause or exhausted weekly budget**
  (D2 is a hard wall; print why in the reply comment so your phone shows it).
- Debounce: at most one triggered tick per 5 minutes; concurrent `/actionnow`s
  queue behind the running tick, they don't parallelize (A2 still holds).

Why not a fixed delay instead of a command: a delay-based trigger ("act on
any comment after 10 min") fires on chatter and burns runs; an explicit
`/actionnow` keeps the human in control of when budget is spent, which is the
whole spirit of D2.

### Acceptance test

Run a task, find `session:` in its ledger entry and issue comment, and
`claude --resume` it successfully. Comment `/actionnow` from the GitHub
mobile app → verify a tick fires within ~2 min with that issue first, and
that a second `/actionnow` from a non-owner account is ignored with no spend.
Comment `/pause` → verify no new runs start; `/resume` → verify they do.
Trigger `/actionnow` during a budget pause → verify it refuses with an
explanatory reply comment.
