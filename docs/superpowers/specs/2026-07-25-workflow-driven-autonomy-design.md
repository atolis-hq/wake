# Workflow-Driven Autonomy Design

**Date:** 2026-07-25
**Author:** Wake (Claude), with decision authority delegated by the operator.
**Status:** Approved by operator; supersedes the Phase 5 design implied by issues
#349-#354/#363 as originally filed. Those issues are re-scoped per §9 below.

## 1. Problem

Issues #349-#354 and #363 (Phase 5, "dark factory") propose an `autonomy:`
configuration section — with `triage`, `review`, `merge`, `approval`
sub-blocks — as a new, parallel policy surface for Wake's remaining
hand-holding steps (who gets assigned work, who reviews a PR, who approves a
stage, who merges). This assumes one fixed pipeline shape and duplicates
concepts Wake's existing `config.workflows.yaml` model already owns: a stage
is already a fresh, isolated agent session with its own prompt and tool
routing; `workflowSelectors` already decides which workflow a piece of work
enters and from what trigger facts.

Building a second config surface on top of the first would fragment where an
operator looks to understand "what will Wake do here" and has already shown
one concrete collision: #363's own open design question about how its
prompt-frontmatter `allowAutoApproval` flag relates to #349's global
`autonomy.approval` block.

This design replaces the `autonomy:` surface with targeted extensions to the
existing workflow model, so triage, review, approval, and (eventually) merge
are all just workflows — configured, versioned, and reasoned about the same
way `docs/workflows.md` already describes.

## 2. Principle

No new global policy namespace. Every autonomous capability is expressed as
an ordinary workflow definition. Where the current workflow engine can't
express something needed, this design adds the smallest targeted extension
that closes the gap — generalized, not special-cased to the capability that
motivated it, because the next recurring or reactive workflow (a digest, a
health check, work discovery against another source) should need zero new
engine code.

Two extensions are needed. Everything else in this design is workflow/prompt
configuration on top of the current engine.

## 3. Extension A — Triggered workflows

**Gap:** Today a workflow only starts because an inbound source event (a
GitHub issue/PR) mints a work item, matched via `workflowSelectors` at
intake. There is no way to start a workflow on a schedule or a state
condition, and a single work item that ran forever would accumulate an
unbounded event stream — a real problem for triage, which by design never
stops.

**Design:** A workflow may declare a `trigger` in addition to (or instead of)
`workflowSelectors`:

```yaml
workflows:
  triage:
    trigger:
      schedule: "*/10 * * * *"
    stages:
      assign:
        action: triage-assign
        workspace: none
        onDone: done
```

Each tick, Wake evaluates configured triggers the same way it polls a
`WorkSource` today. A firing trigger produces a synthetic intake event that
mints a **new**, ordinary `work-<ulid>` and dispatches the workflow's entry
stage — same event/projection/audit path as any GitHub-sourced work item.
The run completes normally (`onDone: done`) and closes. A workflow that
"runs forever" is, from the engine's point of view, an unbroken sequence of
short-lived, independently-bounded runs — nothing new to replay, no special
casing in `core/`.

**`schedule` only, for now.** An earlier draft of this design also allowed a
`condition` (e.g. `wip < 2`) evaluated inline against tick state, but the
predicate vocabulary that would need — what state is visible, how it's
expressed, whether it can reference other workflows' WIP — isn't settled and
would be guesswork to fix here. Dropped from this design. The natural home
for condition-based triggers is likely the same deferred "stage executor"
work in §8 (a script/check Wake runs deterministically) rather than a new
expression language embedded in workflow config — a future extension, not
something `trigger` needs today. `triage` ships schedule-only; a threshold
trigger can be added once that mechanism exists, without changing the
schedule case.

**Scope note:** this extension is deliberately generic. It is not "the
triage trigger" — it is the mechanism any future recurring workflow uses.

**Firing is durable and best-effort on timing, not exact.** Per CLAUDE.md
("the tick is a pure function of durable state… never cache 'what happened
last tick' in process memory"), trigger evaluation must read/write a durable
last-fired record (e.g. `state/triggers/<workflow>.json` or an event), not
in-process state — a crash between deciding to fire and recording it must not
double-fire on restart. The synthetic intake event should carry the same
kind of idempotency key `tick-runner.ts` already uses for outbound
publication, keyed on the workflow name and the fired slot.

Ticks are not periodic (`scheduler.maxIntervalMs` backs off idle polling),
so a `schedule` is evaluated whenever a tick happens to run, not to the
second — "fire if the schedule's next slot has elapsed since the durable
last-fired time" rather than firing once per exact slot. That inexactness is
an accepted trade-off for this design, not a gap: it's a recognized
mechanism (best-effort cron-on-tick), and if tick cadence ever becomes
exact/event-driven, trigger evaluation gets more precise for free without
changing this contract.

## 4. Extension B — Resource-correlated (attached) activities

**Gap:** Review can't be modeled as the next stage after `implement`, because
`implement` doesn't reach `DONE` until the PR is approved and merged — it
returns `AWAITING_APPROVAL` and stays there through review and merge. A
review that must be able to re-fire every time new commits land on the PR
(required for v1 — a one-shot review loses most of its value) also can't be
a single downstream link in an `onDone` chain; it needs to react to activity
on a resource correlated to the work item, independent of the work item's
current primary stage.

Wake already has the correlation mechanism this needs, end-to-end: a PR is a
distinct resource (`github:pr:...`), linked to a work item only via an
explicit `wake.correlation.registered` event (`registerReportedArtifacts` in
`tick-runner.ts` verifies the agent's reported artifact against the provider
and appends it), and PR activity already surfaces on that work item's
watchlist independently of its current stage.

**Dependency to call out explicitly:** registration only happens when
`artifactVerifier` is configured. Without it, no correlation is ever
registered and a `watch` entry attached to that stage never fires — silently,
with no error. `watch` should document this prerequisite rather than assume
it, and Wake's config validation should warn (not just silently no-op) if a
workflow declares `watch` entries but `artifactVerifier` isn't configured.

**Design:** a stage may declare **watchers** — attached workflows that run
as a sibling concern while that stage holds a given status, dispatched by
activity on a resource already correlated to the work item, not by that
stage's own `onDone`. The mechanism is deliberately generic — not named or
shaped around review specifically — so the same field can later attach a
security scan, a notification, or any other reactive workflow to any stage,
without a new config concept per use case:

```yaml
workflows:
  default:
    stages:
      implement:
        action: implement
        workspace: branch
        onDone: done
        watch:
          - on: correlated-resource-activity
            while: awaiting-approval
            workflow: pr-review
```

Reading the fields: `on` names the class of event that dispatches the
watcher (`correlated-resource-activity` today — activity on any resource
already linked to this work item via the correlation registry, e.g. the PR's
`opened`/`synchronize` events; other event classes can be added later
without touching existing watcher definitions). `while` scopes it to a
named stage status — the watcher only dispatches when `implement` is
currently `awaiting-approval`; outside that status, matching resource
activity is ignored. `workflow` is the ordinary workflow to run (its own
stage, prompt, and tool allowlist) each time the watcher fires — here,
`pr-review` (§5).

So yes: concretely for review, the watcher only fires while the owning
stage's status is `awaiting-approval`, exactly as the earlier draft
described — `watch`/`on`/`while` is just the generalized shape that
describes it, so the same declaration form covers whatever gets attached
next.

No `tier`/`runner` field on a `watch` entry — the referenced `workflow`
already carries its own stage-level `tier`/`runner`, exactly like any other
workflow. Routing only needs to be declared once, on the workflow that's
actually dispatched, not duplicated at the attachment point.

`correlated-resource-activity` is currently the only `on:` class, and it's
shaped by what review needs (PR `opened`/`synchronize`). The claim that this
mechanism generalizes rests on future `on:` classes that aren't designed
yet — worth treating as a direction, not a proven property, until a second
concrete use (e.g. a label-added trigger, or a check-run-completed trigger)
is actually built against it.

This is the most structurally significant piece of this design — it
introduces a second concurrently-relevant stage per work item, where today
there is exactly one. It is scoped narrowly on purpose: a watcher triggers
only on the event class and status it declares, and its result is delivered
through surfaces that already exist (§5) rather than a new resumption path.

**Concurrency guard.** Without one, this can loop or race: a `pr-review`
verdict triggers `revise`, which pushes a new commit, which fires a new
`synchronize` event, which dispatches `pr-review` again — and two
`synchronize` events close together could dispatch two concurrent
`pr-review` runs, or a `pr-review` run overlapping a `revise` run against the
same branch. A watcher must not dispatch while any run (the primary stage's
or a prior watcher's) for that work item is already in flight, and must
dedupe on the triggering resource-activity event id so a re-observed event
never double-dispatches.

## 5. Review workflow

A `pr-review` stage's prompt gives it read-only `gh` access (via the
existing `allowedTools` prompt-frontmatter mechanism — no engine change) and
asks it to judge the PR against the originating issue's own acceptance
criteria, mirroring the host-local dark-factory script's `review-prompt.md`
(evidence of what this judgment call needs to look like operationally — not
reference architecture). Its verdict maps onto the **existing sentinel
vocabulary** rather than a new structured field:

- Confident, safe to merge → posts `/approved` as the first line of a
  comment on the **issue** thread. This is the same explicit act a human
  approval already requires (`resolveApprovalTransition` stays issue-thread
  only for the actual merge decision — unchanged).
- Not confident, needs changes → posts a comment on the **PR** thread. The
  in-flight `revise` action (`docs/superpowers/plans/2026-07-19-pr-review-feedback-action.md`)
  already resumes `implement` automatically from PR-surface comments while a
  work item is `awaiting-approval`, with no slash command — this design adds
  no new resumption mechanism, it just gives an automated reviewer the same
  channel a human already has.
- Genuinely uncertain / needs a human's judgment call → leaves the PR alone
  and reports its own run as `AWAITING_APPROVAL`/`BLOCKED` so the item stays
  visibly waiting rather than silently retried.

No `onBlocked` field, no verdict schema addition to `workflowStageSchema`.
This is prompt authoring against mechanics that already exist, plus
Extension B to dispatch it.

**This crosses the operator's original human-PR-approval constraint, on
purpose.** An autonomous `pr-review` verdict posting `/approved` is
indistinguishable from a human approval to `resolveApprovalTransition` — it
satisfies the hard constraint in the roadmap's §1 ("every change must be
approved by a human, at minimum at the pull request") with an agent instead
of a human. That's not an oversight; it's exactly the relaxation the
operator already recorded in the roadmap's 2026-07-25 addendum for
policy-eligible work. Stated here so it isn't mistaken for a gap: this
workflow only runs where the operator has opted a repo/workflow into it —
it's off unless configured, not a default.

## 6. Triage workflow

Per Extension A, `triage` is a workflow triggered on a schedule, not a
per-ticket workflow (a WIP-threshold trigger is deferred per §3's note on
`condition`). Its single stage's prompt is granted
broad `gh` read access — deliberately **not** filtered through Wake's normal
intake selectors, since its purpose is to see what Wake's regular intake
wouldn't (unassigned issues, issues outside the usual attribute filters,
eventually other sources). It looks up the backlog itself (mirroring the
dark-factory script's assignment step as evidence, not architecture) and
assigns an issue directly via its own tool access; Wake enforces only the
WIP cap deterministically before that assignment lands.

This needs no intake changes: assigning an issue is what causes *that* issue
to separately enter Wake's normal pipeline as its own distinct work item,
fully decoupled from triage's own (short-lived, per-firing) work item.

**Named tension with "Wake decides, the agent runs."** #350's original
acceptance criteria wanted deterministic priority ordering (same backlog
state → same selection across ticks), a conflict heuristic, and
always-manual exclusions — i.e. Wake, not the agent, decides what gets
assigned. This design puts that judgment inside the triage agent's own
lookup instead, with Wake only enforcing the WIP cap. That is a real,
intentional narrowing of "Wake decides" for this one decision (what enters
the WIP slot), accepted because triage's whole value is seeing backlog state
Wake's own intake filters don't — a deterministic scorer over that same
broader view would just re-implement judgment as a rule set. Always-manual
exclusions (security-labelled, explicitly excluded work) should still be
enforced by Wake deterministically before triage ever sees a candidate — as
a `requiredLabels`/`ignoredLabels`-style filter on what the triage prompt is
even shown — not left to the agent to honor voluntarily.

## 7. Approval auto-resolution (#353/#363)

Both issues converge into stage/prompt-level configuration — an
`allowAutoApproval`-style frontmatter flag on the relevant prompt, plus a
label/comment trigger (`wake:auto`, `/yolo`) — with no `autonomy.approval`
global block. This resolves #363's own open question: there is only one
configuration surface for this concern, scoped to the stage it applies to,
consistent with `skipApproval` already living in prompt frontmatter today.

## 8. Merge execution — decided, but narrowly scoped

Two separate questions:

**Who decides/executes:** regardless of identity, the merge call itself must
stay deterministic Wake code, never an agent tool call — the "no LLM-facing
tool ever gets merge capability" constraint is about not trusting an LLM's
tool-use for an irreversible action, independent of whose token is used.

**Whose identity:** this design uses Wake's existing shared identity
(`atolis-hq-agent`) to execute the merge once policy conditions pass, per
the roadmap's already-stated posture ("uses Wake's single existing identity,
granted merge rights by the operator directly — a deliberate, temporary
trust posture"). Real identity segregation (a distinct reviewing identity,
GitHub-native auto-merge gated by branch protection) stays Phase 7 (#361)
scope and is an explicit non-goal here.

**Explicitly deferred, not designed here:** what a merge-gate stage actually
*is* in the workflow model — a non-agent stage type, a script-executed
stage, or a pre/post hook around an agent stage — needs its own design pass
(related to the existing #262, "configurable pre/post hooks around agent
runner invocations"). Building a bespoke merge-gate mechanism now risks a
second, competing shape once that design lands. #352 is resequenced behind
it (see §9).

#352's idempotency requirement — a retried/duplicate gate evaluation must not
re-merge or double-comment — carries forward as a hard constraint on
whatever that stage-executor design produces, reusing the existing
idempotent-outbox key pattern (`tick-runner.ts`) rather than inventing a
second one. It is not dropped by deferring the mechanism, only by deferring
*which* mechanism implements it.

## 9. Effect on existing issues

- **#349** — dropped. Replaced by Extension A plus ordinary workflow
  definitions; no `autonomy:` config surface.
- **#350** — narrows to Extension A (recurring workflow triggers, engine
  work) plus a `triage` workflow/prompt (§6, config + prompt authoring).
- **#351** — narrows to Extension B (attached activities, engine work) plus
  a `pr-review` workflow/prompt (§5); no `autonomy.review` config block.
- **#353** and **#363** — converge into one stage/prompt-frontmatter
  mechanism (§7); #363's open design question 1 is resolved by there being
  only one config surface.
- **#352** — re-scoped and resequenced behind a new "stage executors"
  design (§8); not attempted until that design exists.
- **#354** (audit trail) — partially, not fully, satisfied by this design as
  written. Every trigger firing and stage dispatch is already an ordinary,
  replayable event, which covers #354's durability requirement without a
  separate `autonomy:` decision log to reconcile against. Still open, and
  not addressed here: #354's `wake audit <workItemId>`-style CLI/read-model
  and per-decision policy-revision stamping. Since there's no more global
  `autonomy:` policy to stamp a revision hash of, that requirement narrows
  to "which workflow/prompt version was in effect," which fits naturally
  once the stage-executor design (§8) exists — sequenced with it, not
  independently.

## 10. Testing approach

- Extension A: exercise through the existing fakes (`createFakeRunner`,
  `createFileBackedFakeTicketingSystem`) with a fake clock/tick count —
  assert a trigger fires exactly once per elapsed schedule slot (not once
  per tick), survives a simulated crash between firing and durably recording
  it without double-firing, mints a bounded work item, and that item reaches
  `done` without leaving residue that would affect the next firing.
- Extension B: assert a `watch`-attached workflow dispatches only while the
  named status holds, dispatches again on a second correlated-resource event
  (re-review), does not dispatch when the primary stage is in any other
  status, does not dispatch a second time while a prior dispatch for that
  work item is still in flight, and never double-dispatches on a re-observed
  duplicate of the same resource-activity event.
- Review/triage prompts: verify via existing sentinel-parsing tests
  (`domain/schema.ts`) that verdicts map to the intended sentinel, and that
  malformed/unparseable output never defaults to an approving outcome.
- No new zod schema surface is introduced for `autonomy:` — existing
  `workflowStageSchema`/`workflowDefinitionSchema` tests extend naturally to
  cover `trigger` and `watch` as additional optional fields.
