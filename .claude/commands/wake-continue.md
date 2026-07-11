---
description: Resume the Wake autonomy mission — orient, delegate execution to the hosted Wake runner via GitHub issues, keep this session short
---

You are continuing the Wake autonomy mission. This interactive session is a **dispatcher, not a workhorse**: its job is to triage, prepare, and delegate. Execution belongs to the hosted Wake runner, which processes any GitHub issue assigned to it. Keep this session short-lived — orient, take the few dispatch actions needed, hand off, end.

## 1. Orient (cheap, do this first)

- Read `docs/plans/2026-07-11-autonomy-roadmap.md` — §1 is the operator brief and constraints, §3 the phased backlog, §4 the execution rules. Persistent memory has supporting notes (assignment-is-dispatch, deployment-model, autonomy-mission).
- Check in-flight delegated work: `gh issue list --assignee <wake-identity> --state open` and `gh pr list --state open`. Anything assigned is already being processed by the hosted runner — do not duplicate it in this session.
- Check for stalls: blocked/awaiting-approval items with unanswered questions, PRs awaiting review, failed runs.

## 2. Dispatch (strict priority order)

1. **Unstick delegated work:** if a Wake-run item is blocked on a question the durable record can answer, or a PR needs a trivial rebase/CI nudge, do that minimal unblocking action.
2. **Land finished work:** flag approved/mergeable PRs to the operator; after any merge affecting the running instance, remind them to run the update script (`sandbox build` + `sandbox update`) — merges do NOT deploy automatically.
3. **Feed the runner:** if nothing is assigned and in-flight, prepare the next roadmap item in phase order — file its issue if missing (use the matching section of `docs/reports/2026-07-10-simplify-solidify-refactor.md` as the body; refine-quality specs minimize the runner's token spend) — and **assign exactly one issue** to the Wake identity to start it. Assignment is dispatch: never bulk-assign, keep WIP at 1.
4. Update the roadmap/memory if this session made them stale.

## 3. Only execute directly in-session when delegation can't work

Do work in this interactive session only if the item is one the hosted runner cannot safely do to itself — e.g. a bug that breaks Wake's own tick loop, quota handling, or deployment (much of Phase 0). Even then: feature branch, tests, `npm run verify`, PR to `main` for operator approval, docs updated with any CLI/config surface change, token thrift throughout. Everything else gets delegated, not done here.

## 4. Hand off (always end with this)

Finish with a short **Operator handoff** section:
- What was dispatched or done (issue assigned, issues filed, PRs touched).
- What needs the operator: reviews, questions to answer, update script to run.
- Whether and when to run `/wake-continue` again (e.g. "after you merge PR #X" or "after Wake finishes issue #Y").
