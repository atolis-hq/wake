# `watchGate` GitHub verdict-delivery channel — design

## Goal

`watchGate` (`docs/superpowers/specs/2026-08-08-stage-watch-lifecycle-scenarios-design.md`,
Part C) is implemented and tested at the orchestration layer — `TestWorld`
scenarios construct the accepted `OrchestrationSignal` directly, standing in
for a real GitHub round trip. That round trip itself — a watch child's
verdict, or a human's override, actually reaching `orchestration.acceptSignal`
through GitHub — does not exist yet anywhere in `src-next/integrations`
(confirmed: zero references to `watchGate`/`WatchGateVerdictSignal` in that
module). This is the design for building it.

## Two independent paths, one shared signal shape

Matching the original design's *"exactly two ways a verdict-bearing signal
can originate"*:

1. **A watch's own verdict** — a JSON marker embedded in the run-completion
   comment the watch child's own run already produces.
2. **A human — or an external agent imitating one — overriding the gate** —
   the existing `/approved`/`/changes` issue-comment mechanism, generalized,
   with no new human-facing syntax and no Wake-internal concept exposed.

Both end at the same `orchestration.acceptSignal` call, carrying the same
signal kind (`WatchGateVerdictSignal`) and the outcome vocabulary already
established in the orchestration-layer design.

## No gate id — dropped after further thought

An earlier draft of this design introduced a "gate id" so a response could
say *which* `watchGate` wait it was answering, reasoning that a future
external reviewer (Case B below) would need something to reference since it
has no run Wake can cross-check. That reasoning doesn't survive a closer look
at what an external reviewer actually needs to do.

**The key realization: an external agent reviewing a PR is not answering a
specific internal gate — it's imitating a human.** It does its own internal
multi-check review, and only when everything passes does it post a plain
`/approved` (or `/changes`), exactly like a human deciding "I've looked at
this." A given work item's active workflow instance is only ever waiting on
one thing at a time (`WorkflowInstanceView.waitingFor` is a single optional
field, not a list) — so "reply to the ticket" is already unambiguous, for a
human and an external agent alike, with no id needed to disambiguate.

Once Case B doesn't need a gate id for routing, nothing does — Case A's own
authorization was already the durable-run cross-check, not the gate id (the
earlier draft already conceded the gate id was "defense in depth," not the
authorization itself). So: no gate id field, no "publish it when the wait
starts" outbound requirement, no recompute-and-compare inbound step. Simpler
on both ends.

## Two hard-earned scoping decisions from this conversation

- **Case A (watch-spawned child) and Case B (external reviewer) take
  genuinely different paths, not a shared one.** A watch's review is a child
  workflow instance Wake itself spawns and tracks — its verdict travels
  through the dedicated marker + run-cross-check path below, because that's
  the only case where Wake has something durable to verify against. An
  external reviewer Wake never spawned (a separate agent session, a
  different Wake instance, a human running Claude Code manually) is *not* a
  variant of the watch path needing its own new mechanism — it's **already
  covered** by the human-override generalization, the moment that exists.
  Nothing Case-B-specific needs building.
- **Authorization for Case A is a durable-run cross-check, not identity.**
  The marker carries the reporting run's own `runId`. Inbound translation
  looks that run up in Wake's own `RunRepository` — proof Wake actually
  executed it — before trusting anything else in the marker. This
  deliberately does not depend on the comment's GitHub author identity at
  all (unlike the existing PR-review trust model in `activities/pr/
  authority.spec.md`, which is identity-based and stays untouched).
- **One open question for Case B, genuinely fine to leave open:**
  `applyIssueApprovalSignal` currently only marks a signal `authorized: true`
  when `actor.kind === Human` (`inbound-review-signals.ts:103`). Whether
  GitHub reports an external reviewing agent's comments as human-actor or
  bot-actor determines whether Case B works out of the box the moment the
  generalization below ships, or needs a small allowance later (e.g. a
  configured allowlist of trusted external-reviewer identities also treated
  as authorized). This is authorization *policy*, not a missing mechanism —
  decide it when an actual external reviewer needs it.

## A verdict must be an actual verdict — `DONE`/`REJECTED` only

Found while re-checking this design against the six lifecycle scenarios: a
review's own technical failure (`outcome: FAILED`, or `BLOCKED`) is not a
verdict — `E2E-DARKFACTORY-003`'s entire point is that a review which never
renders a verdict must leave its parent untouched. `AgentRunPublicationReactor`
already reports *every* terminal outcome, including failures, so the marker
would exist on those comments too unless explicitly filtered. Two things
must hold:

- **Inbound translation only ever constructs a signal for a marker whose
  `outcome` is `DONE` or `REJECTED`.** A marker reporting `FAILED`/`BLOCKED`
  is recognized and ignored — no signal is constructed or sent at all, the
  same as if the comment carried no marker.
- **`acceptSignal` itself should not silently treat a non-`REJECTED`,
  non-`DONE` outcome as passing.** Checked against the merged engine code
  (`signal-policy.ts`, already shipped): today it only special-cases
  `outcome === 'rejected'`; anything else — including a `FAILED`/`BLOCKED`
  outcome, if one ever reached `acceptSignal` by any path — falls through to
  the pass branch (`resumeToTarget(..., expected.resume)`), which is wrong.
  No existing test exercises this because no existing caller constructs such
  a signal, but it's a real latent gap in already-merged code, not just a
  precaution for this new inbound layer. Worth a defensive fix in
  `acceptSignal` itself (reject/ignore a `watchGate` signal whose `outcome`
  is neither `done` nor `rejected`), in addition to inbound translation never
  constructing one — belt and suspenders, not either/or.

## Marker format

A fenced JSON block, namespaced to avoid colliding with anything a human
might paste, embedded in the watch child's own run-completion comment,
carrying the run's already-computed, uppercase, CLI-facing outcome
vocabulary (`AgentRunPublicationReport.outcome`, unchanged) — translated to
the internal lowercase `ActivityOutcomeKind` only at the inbound adapter
boundary, matching this repo's existing "validate at the boundary, translate
to typed internal contracts" rule:

```json
{
  "wake": {
    "watchGateVerdict": {
      "runId": "run-42",
      "outcome": "REJECTED"
    }
  }
}
```

## Outbound changes

**Not `awaitingApproval` — a new field, but a smaller one now that gate id
is gone.** `awaitingApproval` describes the *reporting run's own instance*
state ("this run's workflow is now waiting"). The watch child's
run-completion comment needs the marker regardless of the *child's own*
status (its own workflow may simply complete after reporting `rejected`) —
what matters is whether its *parent* is waiting on a `watchGate` naming this
specific watch, and whether the child's own outcome is a real verdict
(`DONE`/`REJECTED` only — see above). This requires a lookup the reactor
doesn't currently do: from the child's own view, read
`parentWorkflowInstanceId`; find that parent in the same `orchestration.
listAll()` result already in hand; check whether the parent's own
`waitingFor.signalKind === WatchGateVerdictSignal` and `waitingFor.from`
names this watch.

- `AgentRunPublicationReport` (`integrations/delivery/contracts/intents.ts`)
  gains an optional `watchGateVerdict?: { runId: string }` — `outcome` is
  already on the report, no duplication needed, and only set at all when the
  outcome is a real verdict.
- `projectTerminalAgentRunReport` (`terminal-agent-run-report.ts`) threads it
  through unchanged in shape (an added optional input field).
- `AgentRunPublicationReactor`'s `reportInput` (`agent-run-publication-
  reactor.ts`) computes it: only set when (a) the run's own outcome is
  `DONE`/`REJECTED`, (b) the run's own workflow instance has
  `parentWorkflowInstanceId`/`watchId`, and (c) the parent (found via the
  same `listAll()` call already made) is waiting on a `watchGate` naming
  this watch. Also fix, while touching this function: `awaitingApproval`
  itself is currently hardcoded to `signalKind === 'approved'` — the exact
  same single-signal-kind assumption being generalized on the inbound side
  (see below) needs the same fix here, or a `watchGate` wait would never
  render as "awaiting approval" in its own comment either. This is the only
  outbound signal that a `watchGate` wait has begun at all — no separate
  announcement needed now that there's no gate id to publish.
- `formatAgentRunComment` (`agent-activity/agent-activity.spec.md`'s
  component, `agent-run-comment.ts`) renders the fenced JSON block when
  `watchGateVerdict` is present.

## Inbound changes

**New: the watch's own verdict.** New file (e.g. `integrations/github/
application/inbound-watch-gate-signals.ts`), triggered from the same
`CommentObserved` pipeline `inbound-review-signals.ts` already hooks into:

1. Recognize the `wake.watchGateVerdict` JSON shape in the comment body;
   ignore anything else (including unrelated JSON a human might paste).
2. **`outcome` must be `DONE` or `REJECTED`.** Anything else (a marker
   should never carry `FAILED`/`BLOCKED` per the outbound fix above, but
   validate defensively regardless) → ignore, construct no signal.
3. Look up `runId` in `RunRepository` (already available to bootstrap's
   composition, same repository `AgentRunPublicationReactor` reads). No
   match → ignore, not an error (a stale/forged runId is silently dropped,
   consistent with this codebase's existing pattern for unrecognized inbound
   content).
4. From the matched run's own `workflowInstanceId`, resolve its
   `parentWorkflowInstanceId`/`watchId` via `orchestration.listAll()`
   (mirroring the outbound lookup).
5. Construct `{ kind: WatchGateVerdictSignal, outcome: <translated
   lowercase>, authority: { kind: 'watch', watch: watchId }, providerEventId:
   <comment's own event id>, actorId, actorDecision }` and call
   `orchestration.acceptSignal(parentWorkflowInstanceId, signal, ...)`.

**Generalized: human override — and, for free, external-agent override.**
Two existing pieces, both touched, neither aware that "an external agent" is
even a distinct case:

- `issue-source.ts:89` currently accepts only the exact string `/approved`,
  silently dropping everything else — including `/changes`, despite
  `formatAgentRunComment`'s own help text already telling users to reply
  with it. This is a pre-existing gap this work happens to fix, not
  something newly introduced. Recognize both commands; thread which one
  matched through to the emitted event.
- `applyIssueApprovalSignal` (`inbound-review-signals.ts:78-111`) currently
  hardcodes `kind: signalName('approved')` for every currently-waiting
  instance on the work item. Generalize: for each waiting instance, use
  *that instance's own* `waitingFor.signalKind` (not a hardcoded literal),
  and set `outcome: done` for `/approved`, `outcome: rejected` for
  `/changes` — satisfying a `watchGate` wait exactly the same way it already
  satisfies the `approval` workflow's plain `await`, no separate mechanism.
  Whoever posted the comment — human or external agent — is handled
  identically; only the `actor.kind === Human` authorization check (noted
  above as an open question) determines whether an external agent's comment
  is trusted, and that's a policy question for whenever Case B is real.

## Testing

Provider-boundary work — `TestWorld` can't reach any of this (no real
GitHub). Coverage:

- `integrations/github`'s own test suite, appending synthetic
  `integration.github.*`/`CommentObserved` events directly and asserting the
  resulting `OrchestrationSignal` and `orchestration.acceptSignal` call —
  same pattern as `pr-trust.test.ts`'s existing precedent. Include a case
  proving a `FAILED`-outcome marker constructs no signal at all.
- A fixture-driven `ProcessWorld` test for the full round trip: a fake watch
  child completes, its comment carries the marker, a second `tick()`
  observes that comment and resolves the parent's gate — proving the whole
  chain end to end with fakes, still zero real GitHub calls.
- A defensive unit test on `acceptSignal` itself: a constructed signal with
  `outcome: 'failed'`/`'blocked'` against a `watchGate` wait is ignored, not
  treated as passing.
- Unit tests for the two generalized functions (`reportInput`'s
  `awaitingApproval` computation, `applyIssueApprovalSignal`'s per-instance
  signal-kind/outcome selection) confirming the existing `approval`
  workflow's behavior is unchanged by the generalization.
