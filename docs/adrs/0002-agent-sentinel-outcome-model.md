# 0002: Agent sentinel outcome model

## Status

Accepted

## Context

Wake's agent-facing "sentinel" — the single trailing token (or `status` field
in the structured `wake-result` envelope) every runner invocation ends
with — drove two different kinds of information at once:

1. Did the agent execute its assigned stage to a conclusion?
2. Does advancing the work item require a human to act first?

The four sentinels in use (`DONE`, `BLOCKED`, `FAILED`, `AWAITING_APPROVAL`)
answered these inconsistently per stage:

- `pr-review` (and `plan-review`) overloaded `FAILED` to mean "I reviewed
  this and it needs changes" — a successful review with a negative verdict —
  while the generic harness prompt defines `FAILED` as "something prevented
  you from completing this stage at all" (`stage-prompt.ts`). A `pr-review`
  run that genuinely couldn't verify anything (no GitHub auth, no PR found)
  produced the identical sentinel as one that reviewed the diff and asked for
  changes, so the control plane could not distinguish "infrastructure gap"
  from "review rejection" (issue #476).
- `AWAITING_APPROVAL` was never actually the agent's decision. Each stage
  prompt is built with exactly one of `DONE`/`AWAITING_APPROVAL` in its
  instructed vocabulary, selected by the stage's `skipApproval` config
  (`stage-prompt.ts`'s `sentinelListForApproval`). `tick-runner.ts` already
  distrusted the agent's word choice outright — it coerced a `DONE` reply
  into `AWAITING_APPROVAL` whenever `skipApproval` was `false`, regardless of
  what the agent wrote. The gate was policy all along; asking the agent to
  echo it back was vestigial.

## Decision

Narrow the agent-facing sentinel vocabulary to four flat tokens, each
answering only "did the agent conclude, and how":

| Sentinel | Agent completed its task? | Known next step without a human? |
|---|---|---|
| `DONE` | yes | yes — advance (or wait for an approval gate, see below) |
| `REJECTED` | yes — evaluated a target artifact, verdict is negative | yes — route to the corrective stage |
| `BLOCKED` | no — could not safely decide | no — a human must supply the missing judgment |
| `FAILED` | no — could not execute | no — technical/environmental failure, not a judgment |

`REJECTED` is new and generic: any stage whose role is to evaluate some
target against a bar (a PR, a plan, a future QA gate) reports `REJECTED`
when its own execution succeeded but the verdict is negative and there is a
concrete corrective next step (e.g. "loop back to `implement`/`revise`").
It's distinct from `BLOCKED`, which means the agent itself couldn't render
a verdict at all and a human must decide.

`AWAITING_APPROVAL` is removed from the agent-facing vocabulary entirely.
The approval gate stays as a control-plane concept — a work item can still
be in an `awaiting-approval` status/run-record state — but it is derived
purely from the stage's `skipApproval` config applied to a `DONE` sentinel,
the same way `tick-runner.ts` already forcibly overrode the agent's own
word. The agent never needs to know whether its stage is approval-gated.

`FAILED` reverts to one uniform meaning everywhere, including `pr-review`:
a technical/execution failure with no conclusion reached. It carries
`classifyFailedRun`'s existing structured `failureContext` for detail —
that mechanism is unaffected and is not duplicated onto `REJECTED`, since a
rejection is not a failure.

This keeps the sentinel itself a single flat token recoverable from the
degraded (non-JSON, bare-last-line) parsing fallback in
`parseRunnerResult` — a structured "verdict" field carried only inside the
JSON envelope would be silently lost whenever an agent forgets to emit the
envelope, which is exactly the case the fallback exists to survive.

## Consequences

- `policy-engine.ts`'s and `tick-runner.ts`'s independent copies of
  `isAwaitingApproval` (previously `context.lastRunSentinel ===
  'AWAITING_APPROVAL'`) are unified on `context.status === 'awaiting-approval'`
  — the canonical work-item status already computed once by
  `workItemStatusForRunOutcome` — removing a second, independently-drifting
  predicate.
- The `RUN_COMPLETED_EVENT` payload gains an `approvalGated: boolean` field,
  computed once in `tick-runner.ts` at the point the old coercion used to
  fire (`skipApproval === false` on a `DONE` sentinel). Every place that
  used to test `sentinel === 'AWAITING_APPROVAL'` now tests `sentinel ===
  'DONE' && approvalGated === true`.
- `pr-review`'s (and `plan-review`'s) verdict mapping becomes `DONE` = safe
  to merge/approve, `REJECTED` = needs changes, `BLOCKED` = no safe verdict,
  `FAILED` = couldn't complete the review (no PR access, no auth, crashed).
  The watcher-fold logic in `tick-runner.ts` that posts the
  `changes-requested` marker and folds `context.status = 'changes-requested'`
  onto the parent now triggers only on `REJECTED`, not on `FAILED`/`BLOCKED`.
- Historical events already on disk can carry a literal `sentinel:
  "AWAITING_APPROVAL"` payload from before this change. Per the project's
  event-replay guarantee (`rm -rf .wake/state/` + replay must reproduce
  projections identically), `projection-updater.ts`'s fold normalizes a
  legacy `AWAITING_APPROVAL` payload sentinel to `DONE` with
  `approvalGated: true` before applying any of the new logic, so replay of
  old event streams produces the same practical state as it did before this
  change, without requiring `AWAITING_APPROVAL` to remain a valid value in
  `runnerSentinelSchema`.
- Separately, an *already-persisted* projection or run record (not being
  replayed, just read on an ordinary tick) can also carry
  `context.lastRunSentinel: "AWAITING_APPROVAL"` or a run record's
  `sentinel: "AWAITING_APPROVAL"` on disk. Those fields are read via
  `parseIssueStateRecord`/`parseRunRecord` on every normal tick, not only
  during an explicit rebuild, so `issueContextSchema.lastRunSentinel` and
  the run-record `sentinel` field stay validated against a
  `legacyTolerantRunnerSentinelSchema` (the current four values plus the
  retired `AWAITING_APPROVAL`) rather than the strict `runnerSentinelSchema`
  used to validate a live agent's fresh output. This is narrower than
  loosening the vocabulary generally: only these two at-rest fields accept
  the legacy value; `parseRunnerResult`/`wakeResultEnvelopeSchema` (parsing
  what an agent just said) never do.
