# Runner-quota transparent retry design

## Goal

Restore the capability (present in `archive/legacy`, lost in the rewrite) to
detect a provider "usage limit" / rate-limit / quota response from any agent
runner CLI, pause that specific runner in its pool, and retry the interrupted
work on another pool member without it ever looking like a task failure: no
GitHub publication, no consumption of the workflow's configured `failed`
retry budget, and — when every runner in the pool is currently paused — a
workflow status that is visibly not "active" rather than either crashing or
silently doing nothing.

## Problem

Investigation (this session, against `main` at `edf016c0`) found two
independent gaps:

1. **Nothing classifies a quota failure.** The pause/eligibility machinery
   already exists end-to-end — `RunnerPaused`/`RunnerResumed` control events,
   `createRunnerQuotaReporter` (`src/bootstrap/runner-quota-reporter.ts`),
   `resolveRunnerQuotaResumeAt` (localized/UTC reset-time parsing with a
   30-minute fallback), `controlPlaneProjection`'s `ineligibleRunners()`, and
   `RunnerRegistry.resolve(pool, ineligible)`'s sideways fallback — and it is
   already invoked whenever `execution-activity.ts`'s `runnerResultReporter`
   sees `result.failure?.kind === 'provider-quota-exceeded'`
   (`src/execution/application/execution-activity.ts:150`). But no runner
   adapter (`claude.ts`, `codex.ts`, `cursor.ts`, or the shared `cliRunner`)
   ever produces that failure kind — every nonzero exit is classified as the
   generic `'process-exit'`. The whole mechanism is dead code today.
2. **Even if detected, it would still look like a task failure.**
   `agent-activity.ts`'s `agentOutcome()` turns *any* non-succeeded transport
   into `{ kind: 'failed', data: { reason: 'runner-failed' } }`
   unconditionally. That outcome flows through orchestration's ordinary
   `acceptOutcome` — consuming `route.retry.max` for
   `${stage}:failed` and triggering whatever route is configured for a
   `failed` outcome, which is what publishes to GitHub. There is no
   distinction for a quota condition, unlike `archive/legacy/src/core/quota-backoff.ts`'s
   `resolveQuotaPauseUntil` and `tick-runner.ts`'s `shouldPublishRunResult`,
   which explicitly excluded quota failures from publication and gave them a
   separate `executionOutcome: 'QUOTA_EXHAUSTED'` that never became a
   `workflowOutcome`.

Separately, `RunnerRegistry.resolve` throws a plain `Error` when every
candidate in a pool is ineligible
(`src/execution/infrastructure/runners/registry.ts:33`), and nothing catches
it — it propagates out of `execution.attempt()` uncaught and crashes the
dispatch loop (`src/control-plane/application/advance-once-dispatch.ts:113`).
This is a live gap, not a partially-built path: today, if every runner in a
pool is paused (manually or otherwise), the next tick throws.

## Decision

**Detection.** Each CLI adapter gets its own quota classifier, reusing the
exact keyword sets `archive/legacy` proved in production
(`classifyCodexCliFailure`, `classifyClaudeCliFailure`,
`classifyCursorCliFailure`). Codex additionally parses its JSONL `error`/
`turn.failed` events for the structured message (matching the transcript in
the bug report) rather than grepping raw stdout. A shared exported constant
`ProviderQuotaExceededFailureKind = 'provider-quota-exceeded'`
(`src/execution/contracts/runner.ts`) replaces the magic string. The shared
`cliRunner` factory (`claude.ts`) gains an optional `classifyFailure` hook
that adapters supply.

**Never becomes a workflow outcome.** `agent-activity.ts` tags a
quota-classified transport failure with a new closed-vocabulary
`ActivityFailureCode.RunnerQuotaExceeded` instead of the generic
`RunnerFailed`. `advance-once-dispatch.ts` inspects `run.outcome` for that
tag *before* calling `orchestration.acceptOutcome` and, when present, calls a
new `orchestration.retryRunnerQuotaFailure` port method instead. That method
(new pure domain function `requestRunnerQuotaRetry`, mirroring
`operator-retry-policy.ts`'s `requestOperatorRetry`) marks the current
activation resolved and immediately requests a fresh `ActivityRequested` for
the same stage — no `RetryCounted`, so it never touches the workflow's
configured retry budget, and `orchestration.acceptOutcome` is never called,
so no GitHub-publishing reactor ever sees it. The quota condition remains
visible via the ordinary Run record (`RunRunnerResultReported` still carries
`failure.kind: 'provider-quota-exceeded'` and the provider's message,
inspectable through the existing Run history / transcripts / API / web UI) —
just never as a GitHub comment.

**Retry timing:** next tick, not immediate same-tick looping. The retried
activation becomes newly pending; the existing ineligibility-aware dispatch
path picks it up on a later `advanceOnce` call, now respecting the runner
pause that was already recorded for the failed runner. No change to the
dispatch loop's control flow is required for this part — it already
reselects at the top of every `runDispatchLoop` iteration.

**Pool exhaustion (this plan's scope):** `RunnerRegistry.resolve`'s throw
becomes a typed `NoEligibleRunnerError`. `advance-once-dispatch.ts` catches
it alongside the existing `ActivationClaimConflictError` and stops the
dispatch loop for that tick instead of crashing. This is a deliberate
*interim* behavior — it is correct (no crash, no data loss, retried
automatically once any pool member's pause elapses via the same
ineligibility-aware path) but not yet *visible*: the workflow instance's
status does not change, so an operator watching `wake status` cannot yet
tell "every runner is paused" apart from "nothing is happening to look at
right now." Making that visible needs a new `WorkflowStatus` member and a
dispatch-loop path that re-surfaces such instances as candidates every tick
(mirroring `advance-once.ts`'s existing `Blocked`-with-`pendingActivation`
recovery query) — a distinct piece of work, written up separately as a
follow-on plan once this one lands, per the discussion that reusing
`WorkflowStatus.Waiting` cleanly is blocked by its coupling to
`SignalExpectationView.signalKind` elsewhere
(`operator-retry-policy.ts`'s `isRetryEligibleFailedWait`/`selectOperatorRetryTarget`).

## Scope notes

- **Classification is deliberately narrower than legacy.** `archive/legacy`
  bucketed auth/login failures (`unauthorized`, `authentication`, `permission
  denied`, `api key`, `not logged in`, `login required`) into the same
  "quota" classification as genuine rate-limit/usage-limit signals. This plan
  does not: those terms are common enough in ordinary agent-generated output
  (an agent implementing an auth feature, a build tool's own permission
  error) that matching them against a CLI's raw stdout risks misclassifying
  an unrelated failure as quota-exhaustion — pausing a perfectly healthy
  runner and silently retrying instead of surfacing a real problem. The
  patterns here are restricted to phrasing that is specific to provider
  usage/rate limiting (`usage limit`, `rate limit`, `quota`, `too many
  requests`, `credit balance`, `spend limit`, `session limit`, HTTP `429`).
  An auth/login failure is classified as an ordinary `process-exit` failure
  and surfaces normally (GitHub-published, retry-budget-counted) — that is
  the safer default; broadening the classification later needs its own
  deliberate decision, not silent inheritance from legacy.
- **Claude and Cursor prefer stderr over stdout.** Neither CLI has a
  structured error channel the way Codex's JSONL `error`/`turn.failed`
  events do, so their classifiers match against `stderr` first and only fall
  back to scanning `stdout` when `stderr` is empty — `stdout` on a failed run
  can carry partial agent-generated content (the CLI's own conversational
  output before it crashed), which is a much larger and less trustworthy
  surface to pattern-match than a CLI's own diagnostic stream.
- **Codex only classifies from its own structured error message**, never
  from raw stdout scanning — `extractCodexErrorMessage` already isolates the
  `error`/`turn.failed` event's own `message` field (exactly what the bug
  report's transcript showed); if no such structured message is present, the
  failure is left unclassified rather than guessed at from the raw JSONL
  blob.
- Not in scope for this plan: the visible, auto-resuming `WorkflowStatus`
  for full pool exhaustion (follow-on plan, see above); any change to manual
  pause/unpause (`RunnerControlService` is untouched); any change to how
  `resolveRunnerQuotaResumeAt` computes the resume deadline (already correct
  and already wired).
