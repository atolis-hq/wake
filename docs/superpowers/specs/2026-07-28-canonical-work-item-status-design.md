# Canonical Work-Item Status Design

**Date:** 2026-07-28
**Author:** Wake (Claude), with decision authority delegated by the operator.
**Status:** Approved by operator via brainstorming session; ready for implementation planning.

## 1. Problem

GitHub labels (`wake:status.*`, `wake:stage.*`, `wake:workflow.*`), the
projection's `context.lastRunSentinel`/`lastWorkflowOutcome`, and the UI
board's `deriveCondition` (`src/adapters/http/ui-data.ts`) each independently
compute their own notion of "what state is this work item in," from
overlapping but different inputs, with no single source of truth. This has
already produced two classes of observed bugs:

- **Watcher-run label leaks** (issues #472, #478; partially fixed by PR
  #479): a `plan-review`/`pr-review` sub-run executes a *child* workflow's
  stage against the *same parent* projection, but several of the 9
  independent label-writing call sites in `tick-runner.ts` didn't check for
  that, stamping the child workflow's stage/status onto the parent issue.
  PR #479 closed the two unguarded call sites (claim-time and the
  infra-failure completion path), but the underlying design — 9 places
  independently deciding label strings, none reading from one canonical
  field — remains.
- **Invisible review rejections** (issue #472, tracked further in #477): when
  an automated `plan-review` rejects a plan, nothing distinguishes that from
  "never reviewed yet" — the parent's status silently stays
  `awaiting-approval` as if the review never ran, because there's no status
  value that means "reviewed and rejected."

A broader inventory (done as part of this design's brainstorming) found the
same shape of risk elsewhere:

- **Workflow-name threading**: several label-write call sites pass an
  already-resolved local `workflowName` captured earlier in a run's
  lifecycle, rather than re-reading `context.workflow` at write time. If the
  workflow is reassigned mid-run (`WORKFLOW_SELECTED_EVENT`), the label can
  show the *old* workflow after the reassignment already took effect
  elsewhere.
- **`wake:scheduled-workflow`** has no backing `context` field at all — it
  lives only in the label, so "is this a scheduled item" can only ever be
  answered by reading GitHub, never by reading the projection.
- **`wake:frozen`** is mutated through a special-cased inline write in
  `projection-updater.ts`, bypassing the generic label-event pipeline the
  other three label families go through — and unlike them, has no tick-time
  reconciliation pass, so a failed/lost delivery never self-corrects.
- **`context` itself has no schema** — `issueStateRecordSchema.context` is
  `z.record(z.string(), z.unknown())` (`schema.ts:351`). Every one of its
  ~20 known fields is accessed via ad hoc `as Record<string, unknown>` casts
  and string-literal keys repeated across half a dozen files. This absence
  of a typed accessor layer is the root enabler of the whole class of bug —
  there is no schema that would catch a new ad hoc field, a typo'd key, or a
  write that forgot to set a field its readers expect.

## 2. Principle

One canonical, typed status lives in `context`, computed in exactly one
place (`projection-updater.ts`, folded from events the same way
`lastRunSentinel` already is today — this is not a new pattern, just
consolidating an existing one). Everything else that currently
independently *decides* status — GitHub labels, in particular — becomes a
pure, mechanical *translation* of that one field, owned by an adapter, never
computed by `core/`. A tick-time reconciliation pass keeps GitHub's actual
labels converged on that translation even if a write is lost or a human
hand-edits a label.

Orthogonal facts (frozen, deleted, scheduled) are **not** folded into the
status enum — an item can be `awaiting-approval` and frozen at the same
time, and cramming that into one enum either explodes the value count or
loses information. They're separate, dedicated typed fields (matching the
existing `frozenAt`/`frozenBy` shape, not an array of flag strings — the
three flags are fixed and each carries its own metadata, so a generic
flags-array would need a parallel metadata structure for no benefit).

## 3. `WorkItemStatus`

New enum (`src/domain/work-item-status.ts`):

```ts
type WorkItemStatus =
  | 'queued'
  | 'working'
  | 'awaiting-approval'
  | 'changes-requested'
  | 'blocked'
  | 'done'
  | 'failed';
```

`changes-requested` is new. It means: an automated review sub-run rejected
the current output, or a human replied `/changes` — either way, the
appropriate next step is *the agent's*, not a human's, by default. See §5.

`status` does not replace `context.lastRunSentinel`. `lastRunSentinel` stays
exactly as it is today — the raw sentinel of the last completed run,
consumed by retry/failure-class logic (`belowFailureRetryLimit`,
`chooseRetryActionAfterHumanReply`, etc.) that has nothing to do with
labels or external representation. `status` is the new, higher-level field
folded *alongside* it: it starts from the same run-completion events
`lastRunSentinel` already reads, but additionally incorporates facts
`lastRunSentinel` alone can't express — a review sub-run's rejection, a
human's `/changes` — which is exactly the gap this design closes. Nothing
that reads `lastRunSentinel` today needs to change; `status` is additive.

## 4. Typed `context` schema

`context: z.record(z.string(), z.unknown())` (`schema.ts:351`) becomes a real
Zod object type covering all fields currently accessed by convention:
`failureCount`, `lastRunAction`, `lastCompletedAction`, `lastExecutionOutcome`,
`lastWorkflowOutcome`, `lastFailurePhase`, `lastProcessStarted`,
`lastWorkspaceChanged`, `lastExternalSideEffects`, `lastRetrySafety`,
`blockedFromStage`, `lastFailureClass`, `lastHandledCommentId`,
`pendingApprovalAction`, `pendingApprovalAllowAutoApproval`, `workflow`, plus
the new fields this design adds:

```ts
status: workItemStatusSchema.optional(),
changesRequestedCount: z.number().int().nonnegative().optional(),
frozen: z.object({ at: z.string(), by: z.string() }).optional(),
deleted: z.object({ at: z.string(), by: z.string() }).optional(),
scheduled: z.boolean().optional(),
```

`frozenAt`/`frozenBy`/`deletedAt`/`deletedBy` (currently flat, separate
context keys) are reshaped into the nested `frozen`/`deleted` objects above
for consistency with how the design names orthogonal flags — this is a
mechanical rename touching `work-item-lifecycle.ts` and the freeze/unfreeze
fold in `projection-updater.ts`, not a behavior change.

All new/reshaped fields are `.optional()` — see §8 for why no migration
script is needed.

## 5. `changes-requested` flow

Two triggers fold into the same status, on the *parent's* `context`:

1. A `plan-review`/`pr-review` watcher sub-run completes with a rejecting
   verdict (`FAILED`/`BLOCKED` sentinel).
2. A human comments `/changes` on the issue thread (today handled by
   `resolveApprovalTransition`'s `changesRequested` branch in
   `policy-engine.ts`, which will additionally set `context.status` for
   consistency instead of only returning a transition tuple).

Both set `context.status = 'changes-requested'`, store the
rejecting/human feedback body for prompt-threading (reusing the existing
`promptContextOverrides.parentPendingReviewBody` mechanism already used for
the `BLOCKED` case), and increment `context.changesRequestedCount`. Neither
trigger touches `wake.stage`/`wake.lastRunId` — same watcher-isolation
guarantee PR #479 established for other fields.

**Walking through #472's scenario under this design:**

1. `refine` completes → `context.status = 'awaiting-approval'`.
2. `plan-review` watcher rejects → `context.status = 'changes-requested'`,
   feedback stored, `changesRequestedCount` → 1. `wake.stage`/`lastRunId`
   untouched.
3. Tick-time reconciliation (§6) writes `wake:status.changes-requested` to
   GitHub — one label, one source, correct on the first write.
4. Next tick: `policy-engine`'s `resolveNextEligibleAction` recognizes
   `changes-requested` as actionable and re-dispatches the *original*
   pending action (`refine`) with the feedback threaded into the prompt —
   autonomously, no human involved.
5. Revised plan completes → `context.status = 'awaiting-approval'` again,
   `changesRequestedCount` reset to 0.
6. `plan-review` re-reviews; if it now approves, the existing
   `onSuccess.approve` mechanism resolves the gate exactly as it does today.

**Bounding:** if `changesRequestedCount` exceeds a new config value
(`config.retry.maxChangesRequestedRetries`, same shape as the existing
`retry.maxFailureRetries`), the fold instead sets
`context.status = 'blocked'` — a human has to look at it, rather than an
unbounded auto-revise loop.

## 6. Label translation and reconciliation

**`labelsForWorkItem(projection, config)`** (new pure function, in
`src/adapters/github/status-labels.ts` — adapter-owned, not `core/`, since
the `wake:*` string convention is a GitHub-specific concern) is the *only*
place that turns `context.status`/`frozen`/`deleted`/`scheduled` into label
strings. It replaces `statusLabelForStage`/`statusLabelForOutcome`
(currently duplicated in `tick-runner.ts`) and the ad hoc literal strings at
the 9 existing call sites.

Every existing label-write call site in `tick-runner.ts` collapses to
`deliverOutboundEvent(createLabelsEvent({ ...labelsForWorkItem(candidate,
config), ... }))` — always reading the *current* projection at write time,
never a threaded local variable, which closes the workflow-name-drift risk
found in the inventory as a side effect.

**Tick-time reconciliation** extends the existing `markPendingActionableIssues`
pass (`tick-runner.ts:860-900`) to run against *every* item every tick, not
only ones with an eligible next action (today's gap: a stale label on a
parked `awaiting-approval` item never self-heals, since nothing re-checks it
once there's no next action to take). It diffs `labelsForWorkItem(...)`
against the issue's actual current labels and fires a correcting
`createLabelsEvent` for any mismatch. This subsumes the `wake:frozen`
special case too — freeze/unfreeze label writes move onto the same generic
pipeline instead of the current inline mutation, so they get the same
reconciliation coverage.

## 7. Testing plan

- `labelsForWorkItem`: table-driven unit tests covering each `status` value
  crossed with each flag combination (e.g. `awaiting-approval` + `frozen`
  simultaneously).
- `changes-requested` fold, both triggers (plan-review rejection, human
  `/changes`): assert `context.status` updates and `wake.stage`/`lastRunId`
  do not, mirroring PR #479's watcher-isolation tests.
- Auto-revise end-to-end, reusing the existing `stage watchers` test
  scaffolding in `test/core/tick-runner.test.ts`: `refine` → `plan-review`
  rejects → auto re-run with feedback → `plan-review` approves → gate
  resolves. Assert labels are correct at every step, not just the end state.
- Bounding: drive `changesRequestedCount` past the configured cap and assert
  escalation to `blocked` instead of a further auto-retry.
- Reconciliation: seed a projection whose actual labels don't match
  `labelsForWorkItem`'s output and assert the next tick corrects it.
- Workflow-name-threading regression: reassign `context.workflow` mid-run via
  a `WORKFLOW_SELECTED_EVENT` and assert the next label write reflects the
  new workflow, not a stale threaded value (a risk found during research,
  not yet observed live, but cheap to guard against now that write sites all
  read the current projection).
- Schema back-compat: existing on-disk-shaped `context` objects (missing all
  new fields) still parse against the new schema.

## 8. Migration

No manual backfill script. Wake's `state/` is already documented as a
rebuildable projection (`CLAUDE.md`: "if projection logic changes, it should
be derivable again from `events/`"). All new/reshaped `context` fields are
optional, so existing on-disk projections parse unchanged; `rm -rf
.wake/state && replay` naturally repopulates `status`/`frozen`/`deleted`/
`scheduled` from event history, since the fold logic is what computes them
in the first place. Absent a rebuild, an untouched item simply has these
fields `undefined` until its next real event — no worse than today's
untyped gap, and self-healing as items get touched.

## 9. Out of scope

- The fully derive-on-read alternative (recomputing status from raw
  primitives on every read, storing nothing) was considered and rejected —
  it's a bigger structural departure from Wake's existing fold-and-store
  architecture for a marginal staleness-risk improvement over a
  reconciled, stored field.
- `wake.stage`'s own reverse sync with `wake:stage.*` labels
  (`stageFromLabels` in `projection-updater.ts`, used when folding inbound
  ticket-upsert events) is a related two-way sync but is not changed by this
  design — it's a separate, narrower mechanism (label → stage, only at
  ticket-upsert time) than the status/label drift this design addresses.
