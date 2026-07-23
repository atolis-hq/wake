# Wake Implementation Guide

Status: **accepted direction.** This guide, together with [`vision.md`](../vision.md),
is the authoritative plan. The documents under [`vision-inputs/`](../vision-inputs/)
are early-thinking inputs only — useful for mechanism and provenance, but not
binding. Where they disagree with this guide or the vision, this guide wins.

This document has two parts, deliberately at different levels of detail:

- **Part 1 — MVP** is specified concretely enough to build.
- **Part 2 — Longer-term framework shape** is intentionally lower-granularity:
  it names the directions the MVP should leave room for, without over-specifying
  work we are not doing yet.

Implementers should also read [`builder-notes.md`](builder-notes.md) — the
non-obvious traps and intents that gate success but don't belong in the plan.

The guiding rule from the vision holds throughout: **justify Wake as a simple
loop first.** Everything in Part 2 is added only where the simple loop proves
insufficient.

---

# Part 1 — MVP

## MVP goal

A single, plainly useful thing:

> A resident local **Node** control plane that, on a schedule it owns, picks up a
> GitHub issue, moves it through a small explicit lifecycle, invokes a local
> coding-agent CLI in an isolated workspace, and either opens a pull request or
> asks the human a question — recording everything to disk so work can be
> resumed, audited, and re-entered by hand.

It runs on one person's machine, against that person's own repositories. If this
loop reliably saves coordination effort, Wake is justified and can grow. If it
does not, Wake should be simplified, not expanded.

## What the MVP is deliberately NOT

To keep the first version fast and honest, the MVP explicitly excludes:

- an operating-system scheduler (timing lives in the Node process — see below)
- per-run or per-task containers (the MVP uses one shared, persistent container)
- proactive budget/allowance metering (only simple reactive guards for now)
- the learning loop (captured lessons, weekly distillation)
- concurrent/parallel work items (execution is strictly serial)
- webhooks or any inbound network surface
- self-evolution of workflows
- multi-tenant, hosted, or organisation-fleet operation
- learned or adaptive routing (deterministic rules only)

Each of these appears in Part 2 as a later, individually-justified layer.

## Architecture overview

One persistent Docker container holds everything: a long-running Node process —
**the control plane** — plus the agent CLI it invokes. Durable state sits on a
mounted volume so it outlives the container.

```text
                    GitHub Issues / PRs
                            │  (gh CLI, polled)
                            ▼
 ┌─ persistent Docker container ─────────────────────────┐
 │  ┌──────────────────────────────────────────────────┐ │
 │  │            Wake control plane (Node)              │ │
 │  │  Scheduler (internal tick loop, owns its timing)  │ │
 │  │  Work source adapter  ── GitHub issues + labels   │ │
 │  │  Router / policy      ── deterministic rules      │ │
 │  │  Workspace manager    ── folder|worktree per issue│ │
 │  │  Runner adapter       ── claude -p / --resume     │ │
 │  └──────────────────────────────────────────────────┘ │
 │                    │  invokes, per stage               │
 │                    ▼                                    │
 │          Coding-agent CLI (Claude Code), git, gh       │
 └────────────────────────────┬───────────────────────────┘
                     volume mount │ (survives recreation)
                              ▼
         ~/.wake/  (central state + audit)  •  git repos/workspaces
                              │
                              ▼
                 Commits • Branch • Pull Request
```

Durable state lives **outside the process and outside the container** — on the
mounted volume (`~/.wake/` + repos) and in GitHub (issues, labels, PRs). The
control-plane process holds nothing important in memory, and the container itself
is disposable: recreate it and the loop rebuilds its picture from the volume and
GitHub. This is what makes a resident control plane safe without an OS scheduler
and robust to Docker recreation.

## The control plane process and timing

- It is the container's long-running process (started when the container comes
  up) and stays resident for the container's life.
- It owns its own timing via an **internal tick loop** — a heartbeat interval
  (config, e.g. 30 min) plus an optional faster trigger poll later. There is no
  Windows Task Scheduler / cron dependency; scheduling logic is Node code we
  control and can test.
- **Single-flight for expensive work:** at most one **implementation** run is in
  flight at any moment. Serial execution is a v1 property for expensive runs (a
  single local plan's budget cannot usefully feed parallel implementations, and
  concurrent ones produce conflicting PRs). Cheap **refinement** may still be
  batched (see Lifecycle) — the restriction is about expensive runs, not ticks.
  General concurrency is a Part 2 extension.
- **Never compete with the human:** the loop must not starve your daytime manual
  sessions (Pro-plan limits are shared across the account, wherever sessions
  run). **Quiet hours** and the **PAUSE flag** are the primary, reliable controls
  here. Detecting a running interactive `claude` is a nice-to-have but only works
  if that session is visible from inside the container — a host-side manual
  session generally is not, so do not rely on process-detection as the guard.
- Each tick: reconcile state from disk + GitHub, check gates (pause flag, quiet
  hours, run cap, budget), pick the next eligible work item, run **one stage**,
  persist, release the lock.
- **Restart-safe:** on startup it rebuilds from `.wake/` and issue labels;
  a crashed or killed run is recovered on the next tick as a failed attempt.
- It may optionally be kept alive by a supervisor (the user's choice), but the
  scheduling behaviour does not depend on one.

## Work source: GitHub Issues

The queue is GitHub issues; state is labels. This gives a phone-native
interface, a free audit trail, and zero custom UI.

```text
wake:queue → wake:refine → wake:implement → wake:done | wake:blocked
```

A failed run keeps its current stage and applies `wake:status.failed`; failure
is an execution status, not a workflow stage.

- The issue **body** is the task spec (template: context, acceptance criteria,
  out-of-scope). A missing-criteria issue is rejected/flagged rather than run.
- **Questions are issue comments**; the worker @mentions the owner so mobile
  pushes a notification, and Wake applies `wake:blocked`.
- **Wake-authored comments carry a marker.** In a personal setup the agent and
  the human share the same GitHub account (`gh` auth), so comment _author_ cannot
  distinguish them. Every comment Wake or the worker posts must embed a marker
  (e.g. an HTML comment `<!-- wake -->` — invisible in the UI). Without this,
  unblock detection cannot work at all.
- **Unblocking is automatic:** if the latest comment on a blocked issue lacks
  the Wake marker (i.e. the human wrote it), the item returns to the queue on
  the next tick.
- On completion the PR references `Closes #<n>` and Wake comments the PR URL.

Execution stays **local** (`claude -p` on this machine). GitHub is only the
interface and record; it is not the executor.

## Lifecycle stages

Stages are explicit and pluggable, but the MVP uses a deliberately small set:

1. **refine** — cheap model, **may be batched** (e.g. up to the 3 oldest queued
   issues per tick). Rewrite the issue into the full spec template; if anything
   is ambiguous, post questions and block _now_, before any expensive run.
   Otherwise Wake advances the stage to `wake:implement`. Batching cheap triage means your answers to
   questions arrive while implementation proceeds on already-ready tasks — the
   pipeline never stalls waiting on you, and ambiguity costs a cheap triage
   instead of an expensive implementation run (the largest single token saving
   available).
2. **implement** — stronger model, **strictly one per tick, to completion**.
   Implement against the refined spec, run the project's tests, commit, push a
   branch, open the PR. Includes validation and review-prep for the MVP rather
   than splitting them into separate stages.

Plus the terminal/holding states `blocked`, `done`, `failed`. Additional stages
(explicit plan, separate validate, review) are a Part 2 concern; the stage model
must be data-driven so they can be added without reworking the loop.

**Runner contract (the sentinel).** Each stage's agent invocation must end with
exactly one sentinel on its last line, which Wake routes on. Sentinel meaning is
**per stage** — `DONE` means "this stage's objective is met", not always "PR
opened":

- `BLOCKED` — ambiguous or unmet acceptance criteria; the agent has posted
  specific, answerable questions as an issue comment. Wake labels `wake:blocked`.
- `DONE` — for **refine**: spec rewritten to template, Wake advances stage to
  `wake:implement`; for **implement**: tests passed, branch pushed, PR opened,
  Wake records the PR URL and labels `wake:done`.
- `FAILED` — unrecoverable error, with a one-line reason. Wake increments the
  attempt counter (→ `wake:failed` on the cap).

Parse defensively: take the **last** sentinel occurrence in the JSON `result`
field rather than requiring it to be the literal final line — models drift. No
sentinel found = `FAILED`.

Every invocation also carries a hard `--max-turns` cap (small for refine, larger
for implement); hitting the cap counts as `FAILED`. This is free runaway
protection and should never be omitted.

## Wake Session Model

Wake models each work item through its issue, workspace, recorded session id(s),
and state files. The agent session itself is **not** a persistent process and
does not sit resident between ticks.

The session policy is the important nuance:

- Each stage is an agent invocation. Wake captures and stores the `session_id`.
- Wake does **not** always start a fresh session. Where continuity is valuable,
  a later stage should **resume** the prior session (`claude --resume <id>`) so
  the agent keeps its context instead of re-deriving it.
- Wake does **not** keep a session alive as a running worker either. Resuming is
  reopening a recorded session on demand, not maintaining a live one.
- **Default MVP heuristic:** stages that run close together on the same item may
  share a session; a fresh session is preferred when picking up after a long gap
  or after the human has answered questions (the answer folds cleanly into a
  fresh, cheaper context). Resume-vs-fresh is a policy decision Wake owns and can
  tune; it must not be hard-coded into the agent.

This resolves the contradiction in the input docs: not persistent workers, but
not blindly-fresh-every-time either.

## Execution environment (a single persistent Docker container)

The MVP runs inside **one persistent, shared Docker container** — a durable
sandbox that stays up between sessions, _not_ a container spun up per run or per
task. **Everything runs inside it:** the Wake control-plane Node process, every
agent CLI run, git, and `gh`. There is no host↔container coordination to build —
the host's only jobs are to run the container and provide a volume mount.

- **One durable sandbox, reused.** This matches the vision's preference for a
  single reusable environment over a fleet of per-task containers. Isolation
  between work items is still the workspace + branch (folder or worktree)
  _inside_ the container — not a separate container each.
- **Volume-mounted durable state.** The central Wake home (`~/.wake/`) and the
  git repos/workspaces live on a mounted volume, so state, audit trail, and
  in-progress work **survive container restart or recreation**. The container is
  disposable; the volume is not. Rebuild the image freely; nothing important is
  lost.
- **Credentials persist inside the container.** Claude Code's login (the Pro-plan
  session) must be available in the container and survive restarts via mounted
  `~/.claude` or equivalent. Do not mount host `~/.config/gh` by default;
  authenticate GitHub separately inside the sandbox if Wake needs it there.
  This is a small but real setup task — see the spikes.
- **Windows host specifics.** Prefer a **named Docker volume** (or a path inside
  the WSL2 filesystem) over a Windows bind mount for repos/workspaces — bind
  mounts from NTFS are dramatically slower for `node_modules`-heavy work and
  cause file-watcher and permission oddities. Set the container `TZ` to the
  local timezone or quiet hours will run on UTC. Enforce LF line endings in the
  container (`core.autocrlf=false`) since the repos are shared with a Windows
  host.
- **Per-run or per-task containers** — stronger isolation, or parallelism via
  separate sandboxes — remain a Part 2 extension, not the baseline.

## Isolation and workspaces

- Each managed repo has one **canonical clone** on the mounted volume (e.g.
  `~/wake-repos/<repo>`), kept on `main` and fetched by the control plane.
  Workspaces are created from it; it is never worked in directly by the agent.
- **Refine needs no workspace.** It reads the issue and, at most, the canonical
  clone read-only. Only implement pays workspace-preparation cost.
- Inside the container, each work item gets its own prepared workspace off
  `main`, on a branch `wake/<issue-slug>`. A **separate folder per issue** is an
  accepted mechanism; a git worktree is the alternative. Either is fine.
- Workspace preparation (checkout, dependency install) happens in the control
  plane, **outside** the LLM path. Its startup cost is expected and acceptable,
  not a deal-breaker.
- A workspace holds **only code** — it is an ephemeral working copy, never the
  state-of-record. It is cleaned up after the run; the branch/PR is the durable
  artefact, and all task/run state lives centrally on the mounted volume (below).

## Routing and policy (deterministic)

Simple, scriptable rules only. Inputs: stage, task classification, per-issue
overrides, gates. Decisions Wake makes:

- **Model per stage:** cheap model for refine, stronger for implement; a premium
  model only when an issue explicitly opts in. Do not auto-escalate on retry — a
  failed attempt usually means the spec is bad, which is what `blocked` is for.
- **Resume vs fresh session** (per the model above).
- **Eligibility:** is the item refined? Is main healthy enough? Are we inside a
  gate (pause, quiet hours, run cap, budget)?

## Budget (minimal for MVP)

The MVP does **not** attempt to meter remaining plan allowance. Guards only:

- **quiet hours** — run only in configured windows so background work does not
  starve interactive use;
- **interactive-session awareness** — quiet hours + PAUSE are the reliable guards
  against competing with manual use; process-detection is best-effort only in the
  container model (see the timing section);
- a **hard run cap** per tick/day;
- a **reactive pause:** when an invocation fails with a usage-limit error, parse
  its reset time, write `pausedUntil` to the ledger, and stop starting runs until
  it passes; if no reset time is parseable, back off a fixed interval;
- a **PAUSE flag file** the human can drop to stop new work instantly.

Proactive allowance awareness is a Part 2 feature. The control plane is the right
place to figure out remaining allowance later — via CLI output, an API, Claude
Code hooks, or, worst case, scraping a browser session. A cheap early **spike**
should simply inventory what allowance signal is actually available; committing
to a metering design before that is premature.

## State and audit trail (event-first, centrally owned)

The control plane holds the **complete** state of every task, centrally and
durably. The files on disk **are** the audit trail. Two principles govern this:

1. **Central and single-owner.** All task/run state lives in one central Wake
   home (`~/.wake/`, on the mounted volume — _not_ scattered inside each managed
   repo, and _never_ inside a workspace). Wake is the sole owner and reader of
   that state.
2. **Event-first durability.** Imported and internal events are the primary
   record. Current-state files are projections derived from those events, not
   the source of truth.
3. **Durable beyond any session, task, container, or workspace.** The audit trail
   outlives individual runs. Workspaces are deleted, sessions end, tasks close,
   the container is recreated — the central record on the volume persists.
   Nothing important lives only in process memory or only in an agent transcript.

```text
~/.wake/                # central control-plane home — owns ALL state, permanent
  config.yaml           # timing, sandbox, repo allowlist, caps
  config.workflows.yaml # models, runners, tiers, stage routing
  ledger.json           # per-run cost/duration, pause state
  events/<date>.jsonl   # canonical imported + internal event envelopes
  state/<workId>.json   # derived projection: stage, attempts, session refs, history
  state/index/<xx>.json # reverse index: resourceUri -> workId, sharded by hash
  runs/<run-id>.json    # one record per invocation: model, prompt ref, sentinel,
                        #   session_id, cost, duration, timestamps, gate decisions
  logs/<date>.log       # what the control plane did each tick and why
  PAUSE                 # presence = stop starting new runs
  workspaces/<workId>/  # EPHEMERAL working copy for a run — code only, deleted after
```

Each imported or Wake-produced event should be written as a durable envelope
with a stable id, source metadata, correlation identifiers, normalized
canonical payload, and optional raw/source-specific fragments. GitHub issue
creation, issue comments, label changes, PR reviews, PR comments, and Wake's
own internal decisions should all become first-class events in this stream.

That event model should also support outbound publication intents. For example,
an agent asking a question should not post directly to GitHub or Slack. It
should create or request a Wake event such as "question publish requested", and
the control plane should route that event to the configured sink.

**Agent sessions never own state.** Wake keeps the full picture and injects the
relevant slice into each run: a current projection plus selected recent events,
the prior `session_id` to resume, and (later) applicable lessons. The agent may
read event files directly when needed, but the default path should keep prompts
compact by passing a curated slice rather than the entire stream.

Every meaningful event is appended to the central store: which item was chosen
and why, which model/stage/route the policy selected, each run's inputs/outputs/
cost, every imported source change, and every state transition. The `state/`
projection exists for fast deterministic routing and can be rebuilt if its shape
changes. Together the event stream, projections, and run records let the human
reconstruct exactly what happened, and let Wake resume after any interruption —
a container recreation, a full machine restart, or a task whose workspace is
long gone.

Wake should further distinguish:

- a **global intake/index stream** of all synced external/internal events used
  for queue scanning and prioritization
- a **correlated work-item stream** used to build detailed context once a ticket
  is selected

This matters because some important signals live outside a single ticket thread;
they still need to be available to Wake for pickup decisions and prioritization.

## Safety rails

- never push to `main`, never force-push, never leave the issue's repo;
- run with edit-accept + an allowlist (tests, build, git, `gh pr create`);
  keep isolation (workspace/worktree) as the backstop;
- a hard wall-clock timeout kills a run and counts it as a failed attempt;
- attempt cap (default 3) → move to `failed`; never retry forever;
- **no auto-merge** — human review of the PR is the only quality gate;
- owner-only for any control commands.

## Human interaction and jump-in

- File issues from anywhere (including phone); comments carry questions and
  answers; `@mention` on block drives a mobile notification.
- **Jump into a run:** every invocation's `session_id` is recorded in the run
  record and posted on block/fail, so the human can attach a shell to the
  container (`docker exec -it wake ...`) and `claude --resume <session_id>` to
  see exactly what the agent saw — ideal for post-mortems on failed runs and odd
  PRs. Guidance: _resume to understand; comment to unblock._
- Control commands (`/pause`, `/resume`, priority) can start as just the PAUSE
  flag file in the MVP; comment-driven control is an easy later add.

## Build order

Each step is independently testable.

1. **De-risking spikes** (below) — do these before committing to detail.
2. **Container + volume:** a Dockerfile with node, git, `gh`, and Claude Code
   installed; a mounted volume for `~/.wake/` + repos; persisted Claude and `gh`
   credentials; verify the container survives recreation with state intact.
3. **Control-plane skeleton:** Node app running as the container process, config
   load, tick loop, state store, single locked "run" against a dummy echo command.
4. **GitHub work source:** list/label/comment via `gh`; label↔state reconcile.
5. **Workspace manager:** prepare/clean a folder (or worktree) + branch per issue.
6. **Runner adapter:** `claude -p --output-format json`, parse result, route on
   the DONE/BLOCKED/FAILED sentinel, capture `session_id`, support `--resume`.
7. **Lifecycle:** refine (cheap) → implement (stronger) → PR, with the runner
   prompt contract and the resume-vs-fresh policy.
8. **Budget guards:** quiet hours, run cap, reactive limit pause, PAUSE flag.
9. **Audit/observability polish:** run records, logs, a simple status summary.

## De-risking spikes (do first)

The only real unknowns — everything else is conventional plumbing:

1. Capture a **real** usage-limit error shape from `claude -p --output-format
json` (don't guess the format — grab one and parse against it).
2. Confirm `claude --resume <session_id>` reopens a **headless** session and
   behaves sensibly when a later stage resumes an earlier one.
3. **Persist credentials in the container:** get Claude Code login and `gh` auth
   working inside the container and surviving restart/recreation (mounted config
   dirs or equivalent). This is the likeliest setup snag.
4. Time a real **workspace prepare** (folder/worktree checkout + dependency
   install) inside the container on the target repo, to set a sane run timeout.
5. Inventory what **allowance signal** is actually available (CLI/API/hooks) —
   input to the Part 2 budget work; cheap to check now.

## MVP acceptance test

File three issues: one well-specified, one vague, one vague-then-answered.
Verify: the well-specified one is refined and an implement run opens a PR that
closes it; the vague one gets a questions comment + `wake:blocked` and a
notification; after the owner replies, the next tick returns it to the queue and
it flows through. Confirm every run left a run record with its `session_id`, and
that `claude --resume` on one of those ids reopens the session. Trip the run cap
and confirm the loop pauses with a clear log line, then resumes.

---

# Part 2 — Longer-term framework shape

Lower granularity by design. These are the directions the MVP must not
foreclose, ordered roughly by expected value. Each is added only when justified.

- **Pluggable workflow/lifecycle engine.** Promote the small fixed stage set into
  data-driven stages, transitions, and triggers, with a reusable workflow library
  (feature, bug, refactor, dependency upgrade, docs, security remediation).
  Workflows evolve independently of the models that run them.

- **Runner-adapter abstraction.** The MVP is Claude-Code-native. The seam to
  generalise is the runner adapter (invoke, parse result, resume, report cost).
  A second CLI (e.g. Codex) becomes a second adapter behind that interface —
  this is what "CLI-agnostic" actually means in practice, and it is a v2 concern,
  not a reason to over-abstract the MVP.

- **Budget / allowance awareness.** Replace the MVP's reactive guards with real
  metering once a reliable signal is found (CLI/API/hooks, else browser scrape),
  and make routing budget-aware. This is where "% of weekly allowance" style
  controls live.

- **Zero-LLM deterministic jobs.** High ROI, plain scripts, run even while
  budget-paused: baseline health gate (don't run against a red main), spec
  pre-flight validation, unblock detection, deterministic issue generation from
  existing linters/audits, label/state reconciliation, and a morning status
  digest. Layer these in once the core loop is trustworthy. **Pull the baseline
  health gate forward** — skipping an implementation run when `main` is already
  red is the single cheapest way to avoid the most wasteful failure mode, and is
  worth adding as soon as the implement stage exists rather than waiting for the
  full zero-LLM suite.

- **Learning loop.** Capped, near-free improvement: one-line lessons captured
  inside runs already happening, a size-capped lessons file injected into
  prompts, a weekly cheap distillation, and mining of PR review comments. No
  per-run self-critique, no embeddings over transcripts.

- **Event-driven triggering.** A faster trigger poll for owner commands
  (act-now, pause/resume, priority). Real webhooks only if polling ever becomes
  the bottleneck — they add inbound network surface the local-first model avoids.

- **Stronger / parallel isolation.** Per-task or per-run containers (instead of
  the single shared one) for harder isolation or to run more than one work item
  in flight, gated by whatever the budget model can actually sustain. The single
  shared container and serial expensive runs remain the safe default.

- **Self-evolution, bounded.** Wake proposing improvements to its own workflows
  and policies — but always as normal, reviewable issues/PRs, subject to the same
  safeguards as any other change. Aspirational, never a dependency.

- **Corum integration.** Corum understands software and architecture; Wake
  changes it. Corum knowledge can feed refinement and planning stages so agent
  sessions start with context rather than rediscovering it.

- **Hosted service.** A plausible future, explicitly **out of scope** for this
  vision. The local-first design should not assume it, but the clean state model
  (files + GitHub) leaves the door open.

---

# Conventions

- Label prefix `wake:`; central control-plane home `~/.wake/` (owns all state,
  not per-repo, not per-workspace); branches `wake/<issue-slug>`.
- Durable, centrally-owned state on disk and in GitHub; workspaces are ephemeral
  code-only checkouts; nothing critical held only in process memory or a
  transcript.
- MVP runs inside a single persistent Docker container with volume-mounted state;
  per-task / per-run containers are a Part 2 isolation upgrade.
- Deterministic-where-possible: keep work out of the token path unless it
  genuinely needs agentic reasoning.

# Open questions

- The exact stage set, and where an explicit plan / separate validate belong.
- Default thresholds for the resume-vs-fresh session policy.
- Which allowance signal proves reliable enough to build budget metering on.
- `gh` auth handling and the multi-repo allowlist model for a personal setup.
