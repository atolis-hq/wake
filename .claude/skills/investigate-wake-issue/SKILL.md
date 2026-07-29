---
name: investigate-wake-issue
description: Use when a Wake work item is stuck, erroring, not progressing, showing wrong labels/status, or the whole control-plane loop seems stalled, and you need to diagnose the root cause from the running Wake home/container before deciding what (if anything) to fix.
---

# Investigate Wake Issue

## Overview

Wake's durable state lives entirely under a Wake home's `.wake/` directory
(events, per-item projections, run records, locks, logs), usually mounted
into a running Docker container. Diagnosing a live incident means reading
that state directly, not guessing from GitHub labels or agent chatter. This
skill is a runbook for that investigation. It stops at root cause — it does
not fix anything.

## When to use

- A specific issue/work item looks stuck in a stage, keeps failing, or its
  labels don't match what you'd expect.
- "Wake seems stuck" / nothing appears to be progressing system-wide.
- You need evidence (projection/run/event data) before deciding whether a
  fix is even needed.

## Locate the Wake home and container

Try `~/wake-home` first (the conventional `wake init` target from
`docs/getting-started.md`, run from the home directory). Only ask the user
for the path if it doesn't exist.

Find the running container: `docker ps --format '{{.Names}}\t{{.Image}}'`
(look for "wake" in name/image). Confirm the bind mount:
`docker inspect <container> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'`.

If you just need to *read* files and the host-mounted path is directly
readable, do that — it's simpler than `docker exec`. Reserve `docker exec`
for running a live command inside the container's runtime (e.g. a manual
tick) or reading container-only state (`/proc/<pid>`).

**Windows/Git Bash trap:** `docker exec` mangles any argument starting with
`/` (e.g. `/wake/.wake/...`) into a bogus Windows path. Prefix with
`MSYS_NO_PATHCONV=1`:
```
MSYS_NO_PATHCONV=1 docker exec <container> sh -c "cat /wake/.wake/state/work-XXXX.json"
```
Harmless to include on other shells/platforms.

## Diagnostic playbook

Work through in order; stop as soon as you have a root cause with evidence.

### 1. Find the work item's projection

Work items are keyed by internal ULID (`work-<ULID>`), not the issue
number. Find it by grepping content, never by guessing the ULID:
```
grep -rl '"number": <ISSUE_NUMBER>' .wake/state/*.json
```
Read the full JSON. Key fields: `wake.stage`, `wake.lastRunId`,
`context.lastRunSentinel`, `context.lastRetrySafety`,
`context.failureCount`, `context.lastFailurePhase`,
`context.blockedFromStage`, `issue.labels`, `comments` — especially
`isBotAuthored: false` entries and whether their `id` matches
`context.lastHandledCommentId` (an unhandled human comment changes how the
item gets picked up next).

### 2. Find and read the actual run record(s)

`wake.lastRunId` names the latest run, but list all of them to see history:
```
ls -t .wake/runs/run-<ISSUE_NUMBER>-*.json
```
For each, read `sentinel`, `status`, `executionOutcome`, `summary`,
`failurePhase`, `retrySafety`, and `metadata.reconciledBy` /
`metadata.staleReason` / `metadata.supersededBy` if present — these
distinguish a normal completion from a timeout, a mid-flight death, or
pre-emption by a newer attempt. **Read the `summary` field itself** — it's
often the agent's own plain-language account of what happened (including
full review verdicts or error text), and resolves ambiguity faster than the
enum fields alone.

### 3. Check whether the whole system is stalled

Before treating this as item-specific, rule out a system-wide stall:

- **Locks.** Is `.wake/locks/runner.lock` (or `.wake/locks/tick.lock`) held,
  and is the PID inside it still alive (`kill -0 <pid>` or check
  `/proc/<pid>` inside the container)? A held runner lock blocks dispatch
  for every item, not just one.
- **Resident loop health.** Tail `.wake/logs/start.log` and compare its
  last timestamp to the container's current time (`date` inside the
  container). A large unexplained gap suggests a stuck loop or a recently
  recreated container (`docker inspect <container> --format '{{.State.StartedAt}}'`).
- **Manual diagnostic tick.** Run one live tick to see current behavior
  without waiting for the resident loop's schedule:
  ```
  MSYS_NO_PATHCONV=1 docker exec <container> sh -c "node /app/dist/src/main.js tick --wake-root /wake --no-sandbox 2>&1"
  ```
  This is a genuine diagnostic action, not a side-effect-free query — it
  will dispatch real work if something is eligible. It's a normal,
  idempotent-with-the-system operation and often the fastest way to tell
  whether the loop is currently healthy (`idle`/`processed`) versus stuck
  (`locked`, or it hangs).
- **Global dispatch rate limiting.** Wake enforces one dispatch rate limit
  across the whole system, not per item:
  ```
  grep 'dispatch-rate-limited' .wake/events/<YYYY-MM-DD>.jsonl
  ```
  One item repeatedly winning the "next candidate" race and hitting this
  limit can starve every other item, which looks like "nothing is moving"
  even though no single item is broken.

### 4. Distinguish a sub-workflow/watcher run from the item's own action

Wake dispatches child workflow runs (e.g. `plan-review`, `pr-review`)
against the same parent work item to review its output before
auto-approving. These are separate run records and can transiently show
different labels/stage on the GitHub issue than the parent's real state. If
labels seem to flicker or don't match the parent's own action history,
check for run records with `"action": "plan-review"` / `"pr-review"` for
the same issue number, or `metadata.watcher` / `metadata.watcherWorkflow`.

### 5. Check the actual git workspace for uncommitted state

For an `implement`-stage item, its real workspace is
`.wake/workspaces/work-<ULID>` — **not** the shared canonical clone at
`.wake/repos/<owner>__<repo>`, which is read-only and only used for
`refine`/`plan-review`/`pr-review`. A dirty workspace is a common, concrete
cause of repeated `workspace-validation` failures:
```
git -C .wake/workspaces/work-<ULID> status --short
git -C .wake/workspaces/work-<ULID> diff
```
If it's dirty, read the diff before deciding anything — it may be real,
valuable in-progress work from an interrupted run (worth committing so the
next attempt continues) rather than junk to discard.

### 6. Check config for the numeric knobs that gate retries

`config.yaml`: `retry.maxFailureRetries`,
`sources.github.policy.requiredLabels` / `ignoredLabels` /
`requiredAssignees`, `scheduler.dispatchRateLimit`.
`config.workflows.yaml`: stages per workflow, `watch` blocks defining
sub-workflow reviews, `onSuccess`/`onDone` transitions.
A `context.failureCount` past `retry.maxFailureRetries` is a common, silent
reason a `SAFE_TO_RETRY` item stops actually retrying.

### 7. Read the source if it's still unclear

With the projection/run/event data already gathered as grounding, read
`src/core/policy-engine.ts` (`resolveNextEligibleAction`, `needsWakeAction`
— the single source of truth for "will Wake act on this item next tick")
and `src/core/tick-runner.ts` (`runRunnerTick` — how a candidate is
selected and dispatched each tick). This resolves ambiguity faster than
speculating from symptoms alone.

## General principles

- Distinguish "this one item has a problem" from "the system is stalled"
  before digging deeper into either.
- A run record's `summary` field usually already explains what happened in
  plain language — read it before parsing enum fields.
- GitHub labels can lag behind real state (a human can edit them any time,
  and watcher runs can make them flicker) — never trust labels alone; cross-check
  against the projection and run records.
- This is an investigation runbook, not a fix runbook: stop once you have a
  root cause and supporting evidence. Do not start implementing a fix.

## After you have a root cause

Stop and ask the user (via AskUserQuestion if available, otherwise a plain
question) two things before taking any further action:

1. Whether to file a new GitHub issue documenting the finding.
2. If yes, whether to assign it — this repo's convention is assigning to
   `atolis-hq-agent` when the intent is for Wake's own autonomous pipeline
   to pick up the fix.

Never file or assign an issue without that confirmation.
