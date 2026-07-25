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
      schedule:
        cron: "*/10 * * * *"
    stages:
      assign:
        action: triage-assign
        workspace: none
        onDone: done
```

`schedule` is an object keyed by format (`cron` today) rather than a bare
string, so an interval form (`schedule: { interval: "10m" }`) or others can
be added later without a breaking change to workflows already using `cron`.

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

## 4. Extension B — Watchers (status-scoped, per-item triggered workflows)

**Gap:** Review can't be modeled as the next stage after `implement`, because
`implement` doesn't reach `DONE` until the PR is approved and merged — it
returns `AWAITING_APPROVAL` and stays there through review and merge. A
review that must be able to re-fire every time new commits land on the PR
(required for v1 — a one-shot review loses most of its value) also can't be
a single downstream link in an `onDone` chain; it needs to re-check
periodically while the work item sits in that status, independent of the
work item's current primary stage.

**Design:** a stage may declare **watchers** — attached workflows dispatched
on an event and/or a schedule while that stage holds a given status, not by
that stage's own `onDone`. The schedule half isn't a new engine concept: it
reuses Extension A's `schedule` trigger exactly as specified, scoped to one
work item by an additional status guard:

```yaml
workflows:
  default:
    stages:
      implement:
        action: implement
        workspace: branch
        onDone: done
        watch:
          - while:
              status: [awaiting-approval]
            on:
              event: [wake.run.completed]
            schedule:
              cron: "*/10 * * * *"
            workflow: pr-review
```

`while.status` is a list (matching the same one-or-more shape as
`on.event`, for the same reason: cheap to keep consistent now, awkward to
change later) — dispatched only when `implement`'s current status is one of
the listed values, never dispatched (and nothing to cancel) once it isn't.
A watcher must declare at least one of `on` or `schedule`; both may be
present, and either firing dispatches it (whichever happens first) — the
two are complementary, not alternatives: an
event reacts immediately to the primary stage doing more work, while a
schedule is the backstop for everything an event can't see (e.g. a human
leaving a plain PR comment with no Wake run in between). `workflow` is the
ordinary workflow to run — here, `pr-review` (§5), with its own stage,
prompt, and tool allowlist. No `tier`/`runner` field on a `watch` entry:
that's intrinsic to `pr-review`'s own stage definition, not to this
attachment.

**`on.event` is a general hook into Wake's own event stream, not a
review-specific vocabulary.** Wake's events are plain, dot-namespaced
strings (`wake.run.completed`, `wake.run.claimed`, `wake.correlation.registered`,
`wake.publish.confirmed`, …) with no fixed enum — `sourceEventType` is typed
as a bare string in the schema. `on.event` takes a **list** of those exact
literal type strings (`event: [wake.run.completed]`, or several at once) and
matches occurrences **scoped to this work item's own event stream only** —
not system-wide, so a watcher never fires on some other work item's
activity. For the review case, the signal that "the implementer did more
work" is the same event Wake already writes when any run against this work
item finishes: `wake.run.completed` (its payload carries the sentinel). No
new event-type vocabulary is introduced by this design; a future watcher can
hook any event Wake already emits the same way.

**No correlation-registry dependency, on purpose.** An earlier draft of this
extension dispatched watchers on new *correlated-resource* activity (a PR's
`opened`/`synchronize` events), reusing Wake's `wake.correlation.registered`
mechanism. Dropped: that mechanism is contingent on `artifactVerifier` being
configured, and a work item can legitimately reach `awaiting-approval` with
no correlation ever registered — the watcher would then silently never
fire, for a reason invisible from the workflow config. Rather than depend on
Wake's internal correlation state at all, `pr-review`'s own prompt looks up
the PR itself (broad `gh` read access, same pattern as triage's own backlog
lookup and the dark-factory script's `gh pr list --search "{{ISSUE_NUMBER}}
in:body"`), so the watcher's trigger condition is just `while` plus
`on`/`schedule` — nothing Wake-internal to *depend on*, even though `on`
does read Wake's own event stream (a distinction that matters: `wake.run.completed`
is guaranteed to exist for every run, unlike `wake.correlation.registered`,
which is conditional on configuration).

Avoiding redundant work (not re-judging an unchanged PR every 10 minutes) is
`pr-review`'s own responsibility, not the engine's: it tracks what it already
reviewed (e.g. by PR head SHA) and no-ops cheaply otherwise, mirroring the
dark-factory script's `reviewed-shas.json`. `watch` only guarantees *an
opportunity* to re-check on schedule; whether that check does real work is
up to the attached workflow.

This is the most structurally significant piece of this design — it
introduces a second concurrently-relevant stage per work item, where today
there is exactly one. **Concurrency guard:** a watcher must not dispatch a
new `pr-review` run while a previous one for the same work item (or the
primary stage's own run) is still in flight — otherwise a verdict that
triggers `revise`, pushes a commit, and gets checked again could overlap two
runs against the same branch.

**Event-trigger durability** follows the same contract as schedule firing
(§3): dispatch must be recorded durably (e.g. the id of the last event that
caused a dispatch), not cached in process memory, so a tick crash between
"the event occurred" and "the watcher dispatched" can't double-fire on
restart.

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

Two related, differently-shaped mechanisms, not one:

**BLOCKED-question auto-resolution is just another `watch` entry**, not a
separate mechanism — it wasn't recognized as such in the first draft of
this design, but it's structurally identical to `pr-review` in §4/§5: a
fresh, independent session dispatched while a stage holds a given status
(`blocked` instead of `awaiting-approval`), judging whether to answer on the
human's behalf. It depends on Extension B (§4) the same way `pr-review`
does — it is **not** independent engine work, contrary to an earlier draft
of this document.

**AWAITING_APPROVAL auto-approval is genuinely separate**, and this is
where #363's mechanism converges in: an `allowAutoApproval`-style
frontmatter flag on the relevant prompt, plus a label/comment trigger
(`wake:auto`, `/yolo`), with no `autonomy.approval` global block. Unlike a
watcher, no agent session runs at all — the Wake orchestrator performs the
approval directly, deterministically, once the flag and label both hold.
This resolves #363's own open question: there is only one configuration
surface for this concern, scoped to the stage it applies to, consistent
with `skipApproval` already living in prompt frontmatter today.

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
  named status holds; dispatches on a matching `on.event` occurrence scoped
  to its own work item (and does not dispatch on the same event type
  occurring for a *different* work item); dispatches again on the next
  elapsed schedule slot when both `on` and `schedule` are configured;
  dispatches on any of several event types when `on.event` lists more than
  one; does not dispatch when the primary stage is in any other status;
  does not dispatch a second time while a prior dispatch for that work item
  is still in flight; and stops being dispatched (with nothing to cancel)
  the moment the status changes away from the watched value.
- Review/triage prompts: verify via existing sentinel-parsing tests
  (`domain/schema.ts`) that verdicts map to the intended sentinel, and that
  malformed/unparseable output never defaults to an approving outcome.
- No new zod schema surface is introduced for `autonomy:` — existing
  `workflowStageSchema`/`workflowDefinitionSchema` tests extend naturally to
  cover `trigger` and `watch` as additional optional fields.
