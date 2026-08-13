# Stage/watch lifecycle scenario suite — design

## Goal

Turn six informally-described lifecycle scenarios (plain two-stage workflows
with retries, and dark-factory workflows with watch-triggered review children)
into a deterministic, regression-proof test suite in `test-next/`. Three of the
six (1a, 1b, 1c) are fully specified in Part A and need no production change.
One (2c) is fully specified in Part B, also with no production change. The
remaining two (2a, 2b) needed a real production design decision first — how a
watched reviewer's verdict reaches its parent — which is now resolved, in
Part C: a new `watchGate` concept, and a ticket-mediated verdict channel that
does not depend on the watch and its parent sharing a process. Nothing in
Part C has been implemented yet; it is a settled design, not existing
behaviour, and needs its own implementation plan before 2a/2b's tests can be
written (unlike Part A/B, which need none).

A second, non-CI phase (§ Phase 2) updates the `~/wake-next` Wake home so the
same six scenarios can be watched running for real against the
`atolis-hq/wake-test` GitHub repo with fake runners, for visual confidence —
not a regression test. Its dark-factory half additionally depends on Part C
actually being built, not just designed.

## AC coverage matrix

Every element of the six originally-described scenarios, mapped to what
proves it. "Existing" means already covered elsewhere and deliberately not
re-tested by this suite.

| Original scenario element | Test ID / coverage | Layer |
| --- | --- | --- |
| 1a — two-stage happy path | `E2E-LIFECYCLE-001` | TestWorld |
| 1a — new ticket mints work item | `E2E-LIFECYCLE-004` | ProcessWorld |
| 1a — comment per stage | `E2E-LIFECYCLE-004` (`agent-run.publish-requested`) | ProcessWorld |
| 1a — labels updated per stage | **not covered by this suite** — `wake-labels.ts`'s reconciler is GitHub-only (`integrations/github/provider.ts:27`), never composed for the fake provider `E2E-LIFECYCLE-004` uses; found while writing the implementation plan. Needs a GitHub-fake integration test, out of scope here. | — |
| 1b — fail-once-then-recover (stage 1), fail-twice-then-recover (stage 2) | `E2E-LIFECYCLE-002` | TestWorld |
| 1c — fail 3×, waits on human, human resumes, stage 2 succeeds first try | `E2E-LIFECYCLE-003` | TestWorld |
| 2a — dark-factory happy path, refine gate, implement reject-then-approve | `E2E-DARKFACTORY-001` | TestWorld |
| 2a — `dark-factory` label selects the workflow | `workflow-selector.test.ts`, `intake-rules.test.ts` (existing) | unit / integration |
| 2a — child run card visible on the board | `board.test.tsx` addition (new, small) | component |
| 2a — main work item stage never overridden by a watch directly | asserted inline in `E2E-DARKFACTORY-001`/`-002` (status/stage only changes via accepted Signal or the stage's own activity outcome) | TestWorld |
| 2b — repeated rejection stops auto-retry, shows a blocked state | `E2E-DARKFACTORY-002` | TestWorld |
| 2c — watch child errors out repeatedly, parent stays unaffected | `E2E-DARKFACTORY-003` | TestWorld |
| Human authority always overrides a `watchGate` (Part C invariant, not in the original six but load-bearing) | `E2E-DARKFACTORY-004` | TestWorld |
| Verdict marker → Signal translation itself (both directions) | new dedicated coverage in `integrations/github`'s own suite, once built (not per-scenario here) | integration |

## Part A — settled: plain retry lifecycle (1a, 1b, 1c)

These three need no new production capability. Each was verified by writing
and running the scenario against `TestWorld`, then reading back the exact
event sequence produced — the sequences below are observed fact, not a
prediction.

Common setup: a `default` workflow with two stages, `refine` then `implement`,
each `execution: { workspace: 'none' }`, each backed by a custom `TestWorld`
activity (`registerActivity`) rather than the real `agent`/`fake` runner, so
the attempt-by-attempt outcome sequence is scripted directly instead of driven
by `fake-scenarios.yaml`. One `world.advance(workItemId)` call drives exactly
one Activation (one attempt) to its terminal outcome and any immediate
follow-on dispatch.

### E2E-LIFECYCLE-001 — happy path (1a)

**Given** a two-stage workflow, `refine: on.done.then: implement`,
`implement: on.done.then: done`, no retry config on either.
**When** `refine`'s activity succeeds on its first attempt, then `implement`'s
activity succeeds on its first attempt (two `advance()` calls, one per stage).
**Then**, verified exactly:

- Two Runs recorded, both `status: succeeded`, `outcome.kind: done`.
- The full event sequence, in order:
  `work.item-created`, `orchestration.primary-claimed`,
  `orchestration.instance-started`,
  `orchestration.stage-entered {stage: refine}`,
  `orchestration.activity-requested`, `orchestration.activity-started`,
  `execution.activation-claimed`, `execution.run-started`,
  `execution.run-lease-claimed`, `execution.run-succeeded`,
  `execution.activation-released`, `orchestration.activity-outcome-accepted`,
  `orchestration.stage-entered {stage: implement}`,
  `orchestration.activity-requested`, `orchestration.activity-started`,
  `execution.activation-claimed`, `execution.run-started`,
  `execution.run-lease-claimed`, `execution.run-succeeded`,
  `execution.activation-released`, `orchestration.activity-outcome-accepted`,
  `orchestration.instance-completed`.
- Workflow `status: completed`, `currentStage: implement`.
- Work item `state: open`.

The full ordered sequence, rather than targeted counts/queries (what every
other scenario in this suite uses), is a deliberate choice specific to this
one happy-path scenario, matching `golden-path.test.ts`'s own existing
precedent for exactly this style — proving the complete wire-up once, as the
canonical reference case. It does trade some resilience to internal
execution-layer refactors that don't change observable behavior; that's an
accepted cost for the one scenario whose whole point is being the exhaustive
reference, not a pattern to repeat for scenarios with retries/branches.

Label/comment delivery is deliberately **not** asserted here: `TestWorld` does
not wire the `AgentRunPublicationReactor` or GitHub label reconciliation
(neither is composed outside `bootstrap`). That's proven once, deterministically,
by `E2E-LIFECYCLE-004` below (`ProcessWorld`, not a manual/live check) — not
repeated in every `TestWorld` scenario.

### E2E-LIFECYCLE-002 — retry then recover, independently per stage (1b)

**Given** the same two-stage workflow, `refine` with `failed: { retry: { max:
1 }, then: await-human }`, `implement` with `failed: { retry: { max: 2 },
then: await-human }`.
**When** `refine`'s activity fails once then succeeds (2 attempts: `advance()`
×2); `implement`'s activity fails twice then succeeds (3 attempts:
`advance()` ×3).
**Then**, verified exactly:

- `refineAttempts === 2`, `implementAttempts === 3` (handler-side counters).
- Workflow `status: completed`.
- `retryCounts === { 'refine:failed': 1, 'implement:failed': 2 }` — the two
  stages' counters are independent, keyed `<stage>:<outcomeKind>`.
- 5 Runs total, outcome kinds in order: `failed, done, failed, failed, done`.
- 3 `orchestration.retry-counted` events, 3 `execution.run-failed` events, 2
  `execution.run-succeeded` events.

### E2E-LIFECYCLE-003 — retry limit reached, human resumes (1c)

**Given** `refine` with `failed: { retry: { max: 2 }, then: await-human }`
(so 3 attempts total are permitted: the original plus 2 retries before
falling through to `await-human`), `implement` unconfigured for retry.
**When**: `refine`'s activity fails 3 times in a row (3 `advance()` calls: the
first two are granted retries, the third exhausts the bound and the instance
lands on `await-human`); a human then `acceptSignal`s the wait, which
resumes a 4th attempt of `refine`'s own activity, which succeeds;
`implement`'s activity then succeeds on its first attempt.
**Then**:

- Workflow status transitions `active → waiting → active → completed`
  (`await-human` resolves to `WorkflowStatus.Waiting`, not `Blocked` —
  `Blocked` is reserved for an actual `InstanceBlocked` fact, e.g.
  `repeat.max` exceeded, a rejected causal repeat, or a Watch's own budget
  exhausted; see Part C. No auto-retry is attempted past the 3rd failure —
  the 4th attempt only happens because a human signal explicitly resumed
  it).
- `retryCounts === { 'refine:failed': 2 }` — unchanged by the human-resumed
  4th attempt, matching `E2E-ORCH-WAIT-001`'s already-proven rule that
  resuming a wait doesn't reset the retry budget.
- 4 Runs for `refine` (`failed, failed, failed, done`), 1 Run for `implement`
  (`done`).
- Exactly one `orchestration.signal-accepted` event, carrying the human's
  decision evidence.
- Workflow reaches `completed`.

### E2E-LIFECYCLE-004 — ticket mint and per-stage delivery across the happy path (ProcessWorld)

The three scenarios above deliberately don't touch ticket-minting or comment
delivery — that's this one's job, proven once, at the layer that can
actually exercise it (`ProcessWorld`, driving `main(['tick', ...])` through
the real composition root, per `live-failure-recovery.test.ts`'s pattern),
not per-scenario in `TestWorld`. Label reconciliation specifically is **not**
covered here — see the correction below.

**Given** a `wake-root`-style fixture (new fixture directory, e.g.
`wake-root-lifecycle`) with a fake provider (`integrations.fake`,
`evidenceFile`) and the same two-stage `default` workflow as 1a.
**When** the fixture's evidence names one new ticket, and `runTicksUntilIdle`
drives it through both stages to completion.
**Then**:

- Exactly one work item is minted, correlated to that ticket (not to a
  freshly-generated id disconnected from it) — proving "a new ticket mints a
  work item," which Part A's `TestWorld` scenarios assume via
  `world.createWork` rather than prove.
- **Correction, found while writing the implementation plan:** this scenario
  does **not** assert GitHub label reconciliation. `wake-labels.ts`'s
  reconciler (`createGitHubWakeLabelReconciler`) is wired only onto the
  GitHub provider (`integrations/github/provider.ts:27`, as its
  `maintenance` hook) — never composed for the `fake` provider this fixture
  uses. There is no way for a fake-provider `ProcessWorld` test to observe
  label reconciliation at all; the original draft here was wrong about what
  this layer could prove. Proving label reconciliation end-to-end needs a
  GitHub-fake integration test, out of scope for this suite — same category
  of deferred work as the JSON-marker inbound/outbound translation in Part C.
- A `agent-run.publish-requested` delivery intent (`AgentRunPublicationReactor`)
  is recorded for each of the two successful Runs — proving "a comment on the
  ticket" happens per stage, without re-testing comment *formatting*
  (`agent-activity.spec.md`'s job).
- The work item reaches its terminal state.

This is the one place in the suite that deliberately crosses into
`bootstrap`/`integrations` territory instead of staying at the pure
orchestration layer — everywhere else stays TestWorld-only on purpose, per
your "probably don't need to test this everywhere" framing.

**Label-driven workflow selection** (2a: "ticket has label `dark-factory` to
select the workflow") is not re-tested by this suite at all — it's already
proven by `test-next/unit/orchestration/workflow-selector.test.ts` and
`test-next/integration/integrations/intake-rules.test.ts`.

### Test file plan (Part A)

`test-next/e2e/scenarios/lifecycle-happy-path.test.ts`,
`lifecycle-retry-recovery.test.ts`, `lifecycle-retry-limit.test.ts` — one
`defineScenario` block each, IDs as above, following `retry-boundary.test.ts`
and `blocked-reply.test.ts`'s existing structure exactly.
`lifecycle-ticket-delivery.test.ts` for E2E-LIFECYCLE-004, following
`live-failure-recovery.test.ts`'s `ProcessWorld` structure.

## Part B — settled: watch child that never renders a verdict (2c)

This one doesn't depend on Part C's `watchGate` design, because it never needs
to communicate a verdict at all — the whole point is that no verdict is ever
produced.

### E2E-DARKFACTORY-003 — watch child exhausts retries without a verdict (2c)

**Given** a `parent` workflow whose `implement` stage, on its own `done`
outcome, is put into a wait for `orchestration.child-completed` via an
explicit `world.waitForSignal` call (mirroring `child-completion.test.ts` —
not `watchGates` config; this scenario has no verdict to resolve, so it
doesn't need the real mechanism to prove its point, and ships independently
of Part C, even though `watchGates` exists now). A `pr-review` Watch is
attached (`while: {stages:[implement], statuses:[waiting]}`,
`on.events:[review.requested]`, `maxPerGroup: 2`). The `pr-review` child
workflow's own single stage has `on: { failed: { retry: { max: 2 }, then:
await-human } }` and **no `rejected`/`done` outcome the activity can ever
produce** in this scenario — every attempt is scripted to fail technically
(distinct from 2a/2b, where the activity does render a verdict).
**When** the `implement` activity completes `done`, the parent's wait is
established; a `review.requested` trigger spawns the `pr-review` child; the
child's activity fails 3 times in a row (2 retries granted, then exhausted).
**Then**:

- The child workflow's `status: waiting` (`await-human` resolves to
  `WorkflowStatus.Waiting`, not `Blocked`; see the note on
  `E2E-LIFECYCLE-003` above) — never reaches `completed`.
- No Signal is ever accepted against the parent's wait — because none was
  ever constructed (the whole point: there was no comment to translate,
  since the child never produced an outcome to report). Assert zero
  `orchestration.signal-accepted` events for the parent for the duration of
  this scenario.
- The **parent**'s status remains `waiting`, `pendingActivation` unaffected —
  provably untouched: assert its view is unchanged before/after the child's
  3rd failed attempt.
- No `orchestration.instance-blocked` is recorded on the parent.

This confirms the parent-side inertness intentionally, per your earlier
answer: the parent has nothing to react to until a verdict exists, and a
human deals with the stuck review directly (visible via the child-run card in
the UI), not by unblocking the parent.

## Part C — resolved design: `watchGate` (2a, 2b)

**Design settled. Not implemented yet — needs its own implementation plan
before 2a/2b's tests can be written.**

### The verdict channel: through the ticket, never in-process

Investigating this surfaced that `src/` (the predecessor engine) already
solved verdict delivery once, for the same problem, and deliberately did *not*
pass it in-process. From `docs/superpowers/specs/2026-07-25-workflow-driven-
autonomy-design.md` (§4–5, "Watchers" / "Delivering the verdict"): `pr-review`'s
own `onDone` has no path back into its parent's projection — separate event
streams. *"What actually carries a signal back to the parent is the comment
mechanism ... not stage-chaining."* Approval posts a recognized, bot-authored
marker comment **on the correlated PR**; Wake's ordinary inbound comment
processing (the same path that parses a human's `/approved`) recognizes that
marker as approval for the parent. Rejection is just an ordinary PR comment —
no special schema — picked up by the pre-existing "revise" mechanism that
already resumes `implement` from PR-surface feedback.

The design goal is explicit: **don't rely on watch and parent sharing a
process or a workflow instance**, because a watch may eventually be a
genuinely separate process (a standalone reviewer session, external tooling)
that can't share Wake's in-process orchestration state at all. The ticket is
the only channel guaranteed to reach both. This rules out extending
`ChildCompletedPayload` with the verdict — that only works when Wake itself
owns and runs the child, which won't always be true.

**Exactly two ways a verdict-bearing signal can originate — a human's
ordinary comment, or a watch-authored comment recognized by a marker — never
a third, direct, in-process channel.**

**Marker format:** a fenced JSON block in the posted comment (not the
existing `<!-- wake:agent -->`/`<!-- wake:delivery:<id> -->` HTML-comment
markers used today by `formatAgentRunComment`, which render `outcome` as
human text only, not as parseable structure). This reuses the same shape
already used for agent-reported artifacts (`reportedArtifactSchema`,
`activities/agent/agent-result.ts`) — that convention is currently only read
from the agent's own CLI stdout, in-process, never from a re-fetched comment;
extending a JSON block into the *posted* comment, and parsing it back on
inbound intake, is new. Full JSON shape still to be nailed down at
implementation time, but it carries the review run's own **existing** outcome
vocabulary — see below — not a bespoke one, plus enough identity to correlate
back to the right watch/child. Attempt-count fields are not needed in the
marker: `retryCounts`/`maxPerGroup` already track attempts durably at the
engine level; a reviewer's own idempotency (not re-reviewing a head SHA it
already judged, mirroring the legacy design's `reviewed-shas.json` note) is
that reviewer's own responsibility, not something Wake's marker needs to
carry.

**One signal kind, standard outcome vocabulary — not a bespoke approve/reject
pair.** The review run already produces a standard outcome —
`ActivityOutcomeKind` / the same `'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED'`
already carried by `AgentRunPublicationReport.outcome`. A `watchGate`'s
signal is a single, fixed, engine-defined kind (analogous to today's
`orchestration.child-completed`), whose payload carries that existing
`outcome` value. No separate `approved`/`rejected` signal-kind pair is
invented. **This requires extending the shared `OrchestrationSignal`
contract itself** (`orchestration/contracts/events.ts:236-244`): today it has
`kind`, `resourceId`, `revision`, `actorId`, `actorDecision`,
`providerEventId`, `authority` — no `outcome` field. Every other current
Signal use (human approval, `ChildCompletionSignal`) has no outcome to carry,
so this is a genuinely new field on a contract several call sites already
depend on, not a `watchGate`-local addition — named explicitly in "Production
work" below.

**Human authority always overrides — no config needed from the workflow
author, but real compiler work.** The same signal kind, human-authored (an
ordinary `/approved`/`/changes` comment, translated the normal way
`ApprovalAuthorityKind.Human` already is elsewhere) satisfies or rejects a
`watchGate` directly, regardless of what the gate's configured watch says —
a workflow author never writes a `from` entry for this themselves. Checked
against the actual mechanism this depends on (`signal-policy.ts`'s
`acceptSignal`/`authorityAccepted`): when a `SignalExpectation.from` is
declared at all, an authority not present in that declared list is
rejected outright — `authorityAccepted` has no built-in "human always
passes" case, only "human passes if `human` is one of the declared
entries." So **the compiler MUST always synthesize a `{kind: 'human'}`
entry into a `watchGate`'s compiled `from`, alongside its named watch's own
`{kind: 'watch', watch: <id>}` entry** — this is genuine new compiler
behavior, not a pass-through of author intent, and needs to be named
explicitly as such (see "Production work" below), not left as an implicit
consequence of "no config needed."

### The `watchGate` config concept

Nests under the outcome route it gates, in the same position `await` occupied
before (`on.<outcome>`), since gating is a property of a specific route, not
the stage as a whole:

```yaml
implement:
  activity: implement
  on:
    done:
      then: done
      watchGates: [pr-review]              # shorthand: default onReject
    failed: { retry: { max: 2 }, then: await-human }
```

or, overriding where rejection routes:

```yaml
      watchGates:
        - watch: pr-review
          onReject: { then: await-human }   # default when omitted: re-enter this stage
```

- `watchGates` is a **list** of `{ watch, onReject? }`, not a map keyed by a
  separate gate id: a gate's own identity is already the `watch` it
  references (a stage would never sensibly attach the same watch as two
  different gates), so a synthetic id would only duplicate that. The
  compiler enforces no two entries in the list name the same `watch`.
- Two YAML forms per entry, matching the existing precedent set by
  `ApprovalAuthorityKind`'s own config schema (a bare string or a fuller
  object): a plain string is shorthand for `{ watch: <id>, onReject:
  <default> }`; the object form is only needed to override `onReject`.
- **`watch` is a reference, not a redeclaration.** It names the `id` of a
  Watch already declared in the same workflow's own `watches:` list (which
  owns the trigger condition, `maxPerGroup` budget, and spawned child
  workflow) — nothing about the watch is reconfigured at the gate. The
  compiler MUST reject a `watchGates` entry naming a `watch` that isn't
  declared in that workflow's `watches:` list, the same way an unresolved
  `activity` name is already a compile-time error.
- **`onReject.then` defaults to the current stage** (self-loop = "request
  changes") when omitted, but a workflow author can route it anywhere
  (`await-human`, `done`, a different stage).
- **Loop protection is not reinvented here.** A `watchGate` has no retry
  counter of its own; the Watch's own existing `maxPerGroup` budget is what
  bounds how many times rejection can cause a fresh review to be requested
  (already proven: `GroupBudgetExhausted` → `InstanceBlocked` on the parent,
  `child-loop-guard.test.ts`). Keeping the bound on the Watch (how many
  reviews may be requested) rather than duplicating it on the Gate (what a
  verdict routes to) keeps those two concerns in their existing, separate
  components.
- **Exactly one entry is accepted for now.** The compiler MUST reject a
  `watchGates` list with more than one entry as not yet supported. The list
  shape exists so a future multi-watch requirement (see below) never needs a
  breaking config change — but the pass/fail-aggregation logic for tracking
  several simultaneously-pending gates is genuinely new durable state
  (today's `waitingFor` is a single `SignalExpectation`, not a per-gate
  record) and hasn't been designed. Silently accepting more than one entry
  today would let an operator configure something that doesn't actually
  behave like an AND-join yet.
- **Not deferred to a config detail, but genuinely new domain logic:**
  resuming to `then` vs `onReject.then` depends on the *accepted signal's own
  outcome payload*, not on which signal kind matched — today's
  `acceptSignal`/`resumeToTarget` (`signal-policy.ts`) picks a `resume`
  target fixed at `SignalWaitStarted` time, before the signal exists. This is
  the actual mechanism-level change: resume-target resolution needs to branch
  on the accepted signal's own `outcome` field for a `watchGate`'s wait,
  where it doesn't for a plain `await`.
- **`onReject`'s self-loop is an ordinary Stage-kind resume, not
  retry-shaped — it emits a fresh `StageEntered`.** Checked directly against
  `resumeToTarget` (`orchestration/domain/transition.ts:94-138`): any
  Stage-kind target unconditionally emits `StageEntered` then
  `ActivityRequested`, with no same-stage exemption — that invariant holds
  for every Stage-kind resume, `watchGate` or not. The genuinely separate
  path that *does* skip `StageEntered` is `retry-policy.ts`'s own retry
  grant, which `watchGate` does not invoke. So re-entering `implement` via
  `onReject`'s default is observably a normal stage transition whose target
  happens to equal the current stage — it produces its own `StageEntered`,
  gets no `RetryCounted`, and isn't counted against any `retryCounts` key.
  (This corrected an earlier draft of this document and the scenarios below,
  which incorrectly claimed no new `StageEntered` would fire.)

### Related simplification: inline watch actions, not a forced second workflow block

**Descoped from the current implementation plan** (`docs/superpowers/plans/
2026-08-08-stage-watch-lifecycle-scenario-suite.md`) — making this real
requires `compileWorkflow` to return more than one `CompiledWorkflow` (the
parent plus any synthesized child workflows) and every caller that registers
compiled workflows into a `definitions` map to register all of them, a real
architectural change no scenario in this suite actually needs. The worked
example below still shows it as the target shape, but Stage 4's actual tests
use today's already-working explicit two-block form instead (a `workflows:`
entry the watch's own `workflow:` field references by name, exactly as
`child-completion.test.ts`/`child-loop-guard.test.ts` already do) — treat
this section as a future ergonomic improvement, not current behaviour.

Separate from the gate mechanism itself, but adopted alongside it because the
worked example below needs both: today `watchConfigSchema`
(`orchestration/contracts/config.ts:39-59`) requires `workflow: identifier` —
a Watch always references a full, separately-declared `workflows:` entry.
Every watch seen in this codebase so far (`plan-review`, `pr-review`) is a
single stage — the same shape `StageConfig` already has (`activity`, `with`,
`execution`, `on`). Forcing two separate named blocks (a `watches:` entry plus
a whole separate `workflows:` entry) for what is, in every current case, one
action with a retry policy is ceremony the config author shouldn't have to
carry — the engine's reason to spawn a full WorkflowInstance under the hood
(uniform aggregate, retry policy, event vocabulary, and composability if a
review ever needs its own multiple stages or watches) is real, but it's a
reason for the *engine*, not for the *config surface*.

**Resolution:** `workflow` becomes a union, matching the same shorthand/full
idiom already used twice above (`ApprovalAuthorityKind`, `watchGates`) — a
plain string (today's only form, referencing a separately-declared
`workflows:` entry) **or** an inline object shaped like a single `StageConfig`
(`activity`, `with`, `execution`, `on`), which the compiler synthesizes into a
trivial one-stage workflow internally. No field rename, no new top-level key:
reusing `workflow` for both forms, disambiguated by shape, avoids a naming
collision that a bare "inline the stage fields onto the watch entry" approach
would have hit — `WatchConfig` already has its own top-level `on: { events:
[...] }` for the trigger condition, which would otherwise collide with
`StageConfig`'s own `on: {...}` for outcome routing. Nesting the inline form
under `workflow` keeps the two `on`s apart by construction. The existing
string form remains the escape hatch for the rare case a review genuinely
needs more than one stage.

**Synthesized names, pinned exactly (not left to implementation discretion):**
the internal workflow name is `<parentWorkflowName>:watch:<watchId>` —
reusing the identical construction already used for a child *instance's* own
identity (`<parentWorkflowInstanceId>:watch:<watchId>:trigger:<triggerId>`,
`child-workflow-policy.spec.md`), just one level up, at the workflow
*definition* rather than the instance. Guaranteed not to collide with an
author-chosen top-level `workflows:` name, since `:` can't appear in an
`identifier`. The single synthesized stage inside it is named identically to
the watch's own id (`<watchId>`) — unique is trivially satisfied since
there's exactly one stage. This makes retry-key derivation for an inline
watch's own activity deterministic: `<watchId>:<outcomeKind>` (e.g.
`pr-review:failed`), used in `E2E-DARKFACTORY-002` below.

### Worked example: the dark-factory workflow, in full

```yaml
workflows:
  dark-factory:
    entry: refine
    watches:
      - id: plan-review
        while: { stages: [refine], statuses: [waiting] }
        on: { events: [execution.run-succeeded] }
        maxPerGroup: 1
        workflow:                                    # inline shorthand
          activity: agent
          with: { template: plan-review }
          execution: { workspace: read-only, runnerPool: fake-reviewer }
          on:
            done: { then: done }
            failed: { retry: { max: 1 }, then: await-human }
      - id: pr-review
        while: { stages: [implement], statuses: [waiting] }
        on: { events: [review.requested] }
        maxPerGroup: 2
        workflow:
          activity: agent
          with: { template: pr-review }
          execution: { workspace: read-only, runnerPool: fake-reviewer }
          on:
            done: { then: done }
            failed: { retry: { max: 2 }, then: await-human }
    stages:
      refine:
        activity: agent
        with: { template: refine }
        execution: { workspace: read-only, runnerPool: standard }
        on:
          done:
            then: implement
            watchGates: [plan-review]
      implement:
        activity: agent
        with: { template: implement }
        execution: { workspace: branch, runnerPool: standard }
        on:
          done:
            then: done
            watchGates: [pr-review]
```

The rare multi-stage-review case keeps today's form — `workflow` takes a name
instead of an inline object, referencing a normal, separately-declared
`workflows:` entry:

```yaml
      - id: plan-review
        while: { stages: [refine], statuses: [waiting] }
        on: { events: [execution.run-succeeded] }
        maxPerGroup: 1
        workflow: plan-review-multi-stage   # references workflows.plan-review-multi-stage
```

### Scenario definitions: E2E-DARKFACTORY-001 (2a) and E2E-DARKFACTORY-002 (2b)

Both run against `TestWorld`, using the worked-example config above. Neither
exercises the real GitHub JSON-block marker or inbound translation — that
round-trip gets its own dedicated coverage where it's actually implemented
(`integrations/github`'s own test suite proving marker → `OrchestrationSignal`
translation), the same way Part A doesn't re-prove label string formatting.
Here, the "a comment carried the verdict back" step is stood in for directly:
the child workflow runs for real (proving spawn, retries, and the visible
child-run — see the UI item below), and the test then constructs the
resulting Signal via `world.acceptSignal` with `authority: {kind: 'watch',
watch: <watchId>}` (the compiled `ApprovalAuthority` shape,
`orchestration/contracts/config.ts:161-164` — note the field is `watch`, not
`id`; `id` only appears in the raw config form of an authority entry, e.g.
inside a stage's `from` list) and the child's own outcome as payload. This is
`blocked-reply.test.ts`'s pattern specifically — manually constructing and
calling `world.acceptSignal` — **not** `child-completion.test.ts`'s, whose
parent resumption happens automatically via the engine's own child-completion
reconciliation on `world.advance()`. `watchGate` deliberately bypasses that
automatic path (per the verdict-channel design above), so only the manual
construction pattern applies here.

Re-entering a stage because its `watchGate` rejected **is an ordinary Stage
resume through `resumeToTarget`, and does produce a fresh `stage-entered`
event** — verified against `transition.ts`; there is no same-stage exemption
in that path, unlike a granted retry (which goes through a structurally
separate function and genuinely doesn't emit one). It's retry-*shaped* in
effect (the same Activity runs again), but not retry-*accounted* — no
`RetryCounted`, no `retryCounts` key.

**E2E-DARKFACTORY-001 — dark-factory happy path, one reject-then-approve cycle (2a)**

**Given** the worked-example config; `plan-review`'s child always succeeds;
`pr-review`'s child rejects on its first trigger, then approves on a second.
**When**:

1. `refine`'s activity succeeds → parent's `watchGate` wait is established.
2. A `plan-review.requested` trigger spawns the `plan-review` child; its
   activity succeeds (`done`).
3. The resulting Signal (`outcome: DONE`, authority `{kind: watch, watch: plan-review}`)
   is accepted → gate passes → parent enters `implement`.
4. `implement`'s activity succeeds → parent's `watchGate` wait (`pr-review`)
   is established.
5. A `pr-review.requested` trigger (trigger id `pr-1`) spawns the first
   `pr-review` child; its activity produces `rejected`.
6. The resulting Signal (`outcome: REJECTED`, authority `{kind: watch, watch: pr-review}`)
   is accepted → gate fails → `onReject` (default: re-enter `implement`)
   fires → `implement`'s activity is requested again, fresh.
7. `implement`'s activity succeeds again → parent's `watchGate` wait is
   re-established.
8. A second, distinct `pr-review.requested` trigger (trigger id `pr-2`)
   spawns a second `pr-review` child; its activity produces `done`.
9. The resulting Signal (`outcome: DONE`) is accepted → gate passes → parent
   reaches `done`.

**Then**:

- `orchestration.child-requested` recorded exactly once for `plan-review` and
  exactly twice for `pr-review` (trigger ids `pr-1`, `pr-2`) — within
  `maxPerGroup: 2`, no budget exhaustion.
- Exactly three `orchestration.stage-entered` events total (`refine`,
  `implement`, `implement` again for step 7's re-entry) — each a genuine
  fresh `StageEntered`, per the corrected mechanism note above; the 2nd and
  3rd both target `implement` but are still two distinct events.
- Zero `orchestration.retry-counted` events for `implement` — the reject-then-
  retry cycle is a `watchGate` self-loop, not a counted retry.
- Parent `status: waiting` while each `watchGate` is pending (after step 1,
  and again after step 4, before their respective Signals are accepted) —
  the "awaiting approval" state the original scenario calls out explicitly
  at both gates, not just the final `completed` status.
- Zero `orchestration.instance-blocked` events.
- Workflow reaches `status: completed`.
- The parent's `currentStage`/status only ever change through an accepted
  Signal or its own activity's outcome — never a direct mutation from a
  watch or child.

**E2E-DARKFACTORY-002 — repeated rejection exhausts the watch budget, blocking the parent (2b)**

Matches the original description's actual mechanism, not just its outcome:
three *real* review cycles happen, each rendering a real verdict — the first
with two technical failures before its verdict, exactly as described ("the
first watch fails 2 times then rejects") — not a truncated version where a
later trigger is silently swallowed by the budget before any review runs.
`maxPerGroup: 3`, so all three children actually spawn and reject.

One interpretation call, stated explicitly rather than left implicit: "the
third watch rejects — implement doesn't run again" is read here as *no
further validated `implement` cycle is possible*, not literally that
`implement`'s own activity never executes a 4th time. `onReject`'s default
behavior (re-enter the stage) is unconditional — it has no "unless the watch
budget is exhausted" special case in this design — so `implement` does run a
4th time after the third rejection; what's actually blocked is the *next*
attempt to request a review of that 4th attempt, once it completes.

**Given** the same worked-example config, but `pr-review`'s watch
`maxPerGroup: 3`. `pr-review`'s own single stage: `on: { done: { then: done
}, rejected: { then: done }, failed: { retry: { max: 2 }, then: await-human
} }`.
**When**:

1. `implement` succeeds → `watchGate` wait established.
2. Trigger `pr-1` spawns child #1. Its activity fails, fails (2 retries
   granted, `retry.max: 2` for `failed`), then rejects on its 3rd attempt —
   `rejected` has no retry config, so it resolves directly. `REJECTED`
   Signal accepted → `onReject` fires → `implement` re-requested, fresh.
3. `implement` succeeds again → `watchGate` wait re-established.
4. Trigger `pr-2` spawns child #2 (2nd of `maxPerGroup: 3`); its activity
   rejects on its first attempt. `REJECTED` Signal accepted → `onReject`
   fires → `implement` re-requested, fresh.
5. `implement` succeeds a third time → `watchGate` wait re-established.
6. Trigger `pr-3` spawns child #3 (3rd and last of `maxPerGroup: 3`); its
   activity rejects on its first attempt. `REJECTED` Signal accepted →
   `onReject` fires → `implement` re-requested, fresh (its 4th attempt).
7. `implement` succeeds a fourth time → parent attempts to re-establish the
   `watchGate` wait, which requires requesting a new review.
8. Trigger `pr-4` attempts to spawn a fourth child — the budget is already
   exhausted (3 of 3 used).

**Then**:

- `orchestration.child-requested` recorded exactly three times for
  `pr-review` (`pr-1`, `pr-2`, `pr-3`); no fourth child is ever started.
- `orchestration.retry-counted` recorded exactly twice, both on child #1's
  own stream (`pr-review:failed`, per the synthesized stage-naming rule
  above), zero times on children #2/#3.
- `orchestration.group-budget-exhausted` recorded for trigger `pr-4`'s
  request.
- `orchestration.instance-blocked` recorded on the **parent** (not on any
  child) — this is the "way to show a blocked state" that protects against a
  repeating watch loop.
- The parent's `status: blocked`.
- `implement`'s own activity does run a 4th time (step 7) — the block is on
  requesting a review of that attempt, not on the attempt itself, per the
  interpretation above.
- The parent's `currentStage`/status only ever change through an accepted
  Signal, its own activity's outcome, or the budget-exhaustion block —
  never a direct mutation from a watch or child.

**E2E-DARKFACTORY-004 — a human's own decision always overrides a `watchGate`**

Part C states this as a fixed, load-bearing property of `watchGate` in
general — a human's own accepted signal always satisfies or rejects a
`watchGate`, via the compiler-synthesized `{kind: 'human'}` authority entry
described above — and it had no scenario exercising it at all until this one.

**Given** the worked-example config; `implement`'s `watchGate` wait is
established (`pr-review`), no watch trigger has fired.
**When** a human's own Signal is accepted directly — same signal kind,
`outcome: DONE`, `authority: {kind: 'human'}` — with no `pr-review` child
ever having been requested.
**Then**:

- The gate passes on the human's signal alone; zero `orchestration.child-
  requested` events for `pr-review` for the whole scenario — the human
  didn't need the watch to run at all.
- Workflow reaches `status: completed`.

A second case in the same scenario: a human's `outcome: REJECTED` signal,
accepted while a `pr-review` child is mid-flight (already requested, not yet
resolved) — asserts the human's rejection satisfies `onReject` immediately,
without waiting for the in-flight child to finish, and that the child's own
eventual (now-moot) verdict, if it arrives after, does not double-fire
`onReject` (the wait has already moved on).

**Note:** `plan-review`'s own `failed`/`retry`/`await-human` branch (identical
shape to `pr-review`'s) is never driven to failure by any scenario above —
2a's `plan-review` always succeeds first try. Not adding a dedicated scenario
for it: it's structurally the same path Part B (`E2E-DARKFACTORY-003`) and
`E2E-DARKFACTORY-002`'s child #1 already exercise for `pr-review`, and a
`watchGate`'s own retry-exhaustion behavior doesn't depend on which specific
watch it's attached to.

### UI coverage: the child-run indicator (2a)

"The child run card displays on the card in the UI" (2a) is not covered by
any existing test — `board-card.tsx` already renders an `activeRun`
indicator, but `board.test.tsx` never exercises it. Add a render assertion
(component-level, `surfaces/web/test/board.test.tsx` or a sibling file) that
a board card shows the child-run indicator when the work item's view carries
an active child run, and does not when it doesn't. This is a separate test
layer from the six backend scenarios above, not a new backend behaviour.

### Test file plan (Part C)

`test-next/e2e/scenarios/dark-factory-happy-path.test.ts` (E2E-DARKFACTORY-001),
`dark-factory-loop-guard.test.ts` (-002), `dark-factory-human-override.test.ts`
(-004) — `defineScenario` blocks, `TestWorld`-based, following the same
structural conventions as Part A/B. `E2E-DARKFACTORY-003` (2c, Part B) lives
in `dark-factory-child-error.test.ts`. The board-card render assertion lives
in `surfaces/web/test/board.test.tsx` (or a sibling file), a different test
runner/layer from the rest of this suite.

### Deliberately deferred, not designed now

- **N>1 watches on one stage, all required (AND-join).** You raised this as
  a near-future requirement (e.g. code review, domain-correctness review,
  test review, all three required). The list-shaped config already
  accommodates it without a breaking change; the actual join semantics
  (durable partial-acceptance tracking, whether it's strict AND or a
  threshold) are left for that future requirement to design against a real
  case, rather than guessed now.
- **Merge authority.** A `watchGate` passing means *"Wake's own automated
  review is satisfied, ready for a human"* — it routes the stage to `done`,
  nothing more. It does **not** authorize a merge. `activities/pr/
  authority.spec.md` already refuses to trust a bot actor for the
  human-merge-authority decision, and that stays untouched — a `watchGate`'s
  authority check and merge authority are different decisions in different
  components already, and the discipline is simply never to wire one into
  the other. Actual merging stays exactly as it is today, behind real human
  review; dark-factory automates the pre-review gate, not the final
  approval.

### Production work this implies (not built yet)

Corrected and completed against an independent design-vs-scenario review;
the earlier version of this list undersold the actual blast radius.

1. **Contract:** `OrchestrationSignal` (`orchestration/contracts/
   events.ts:236-244`) gains an `outcome` field carrying the standard
   `'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED'` vocabulary — every current
   call site (human approval, `ChildCompletionSignal`) has none today.
2. **Outbound:** extend the review run's posted comment to embed the
   JSON-block marker (today's `formatAgentRunComment` renders `outcome` as
   text only).
3. **Inbound:** GitHub inbound translation recognizes the JSON-block marker
   on a correlated PR (from the watch's own trusted identity, or an ordinary
   human comment) and produces an `OrchestrationSignal` carrying the
   existing outcome vocabulary and the right authority
   (`{kind: 'watch', watch: <watchId>}` or the human default).
4. **Orchestration:** the `watchGate` compiled config (list, single-entry
   validation, referential integrity against `watches:`), and the
   outcome-dependent resume-target resolution in `signal-policy.ts`/
   `activation-policy.ts` described above.
5. **Compiler — human-override synthesis:** every compiled `watchGate`'s
   `SignalExpectation.from` MUST include `{kind: 'human'}` alongside its
   named watch's own authority entry, synthesized automatically — never
   written by a workflow author. Without this, `authorityAccepted`
   (`signal-policy.ts:95-112`) rejects a human's own signal outright, since
   it has no built-in "human always passes" case.
6. **Compiler:** `watchConfigSchema`'s `workflow` field becomes a union
   (identifier string, or an inline `StageConfig`-shaped object), synthesizing
   an internal single-stage workflow named `<parentWorkflowName>:watch:
   <watchId>` with one stage named `<watchId>`, per the naming rule above.

**Not required, despite an earlier draft assuming otherwise:** no change to
`transition.ts`/`resumeToTarget` — `onReject`'s self-loop uses that path
completely unmodified (see the corrected mechanism note above); the earlier
"no new `StageEntered`" claim was wrong, not a requirement that needs new
code to satisfy.

**Left open, to pin down before implementation, not before this design
gate:** what `resourceId`/`revision` (if anything) a `watchGate` Signal
should carry — neither Part C nor the `TestWorld` scenarios currently
constrain them, which means neither side of a future correctness check
(compiled `SignalExpectation` vs. real inbound translation) would catch a
mismatch there.

## Part D — Phase 2 (manual, not CI, blocked on Part C actually being built)

Once Part A's three scenarios pass, and separately once Part C is implemented
(not just designed) and 2a/2b/2c have their own tests, extend `~/wake-next`'s
`config.workflows.yaml`/`fake-scenarios.yaml` to drive the same scenarios
against the real `atolis-hq/wake-test` repo with fake runners, using the
already-implemented `FakeScenarioResolver`
(`execution/infrastructure/runners/fake-scenarios.ts`). This is a visual
walkthrough, not a regression test.

**Fake label prefix.** You raised prefixing labels (e.g. `fake:`) to
distinguish fake-runner activity from real activity on the real
`atolis-hq/wake-test` repo, since Phase 2 runs against a real repo other
people/tooling might also see. This is a `~/wake-next` fixture/config
concern specific to Phase 2, not something the deterministic suite (Parts
A–C, all fully local/in-memory) needs — there's no real-vs-fake ambiguity to
disambiguate when nothing ever touches a real repo. Decide and apply it when
Phase 2 is actually built, not before.

## Out of scope / explicit non-changes (unaffected by Part C)

- No change to `reconcileChildCompletions` or any propagation of a stuck
  child's status to its parent (2c) — the child ends `waiting` on
  `await-human`, not `completed`, and that's confirmed correct existing
  behaviour.
- No forcing of a terminal verdict on a watch child's exhausted technical
  retries. A child stuck on `await-human` with no verdict ever rendered
  (2c) and `rejected` (2a/2b, a verdict was rendered) stay semantically
  distinct regardless of how Part C
  resolves.
