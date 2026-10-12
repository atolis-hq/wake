# Spec: triggered delivery oversight

**Status:** proposed, ready for review; behavior is not implemented by this document.
**Date:** 2026-10-12.
**Implementation baseline:** `d58d99154cd936b95b461c320e45b39a1b4423da`.
**Scope:** explicit event/cron-triggered workflows, typed eligibility gates, artifact context scopes across runs, GitHub backlog assignment and guarded intake.

## 1. Intended outcome and recommendation

Wake should choose useful work when capacity permits, using either general triage or an operator-defined delivery focus. Selection should adapt when that focus changes, survive restarts, and favor completing valuable deliveries rather than merely keeping every agent busy.

**Recommended approach: generalize Control Plane schedules into explicit triggers and implement delivery oversight as an ordinary configured workflow.** The first oversight activity inspects GitHub and assigns at most one suitable issue using `gh`; Wake observes that assignment through normal polling/intake. Keep eligibility, admission and dispatch deterministic. Agent judgment selects work but does not launch runner sessions or choose workflow transitions. A richer typed selection/priority command can follow if needed; it is not a prerequisite for the first release.

Memory is durable context, not a requirement for one persistent agent session. Reuse canonical artifacts for assessment notes, supplied focus and handover through explicit context scopes. Scope references, intake facts and trigger recovery state remain typed facts/state under their owning boundaries. A new agent session must be able to continue correctly from those records. Prompt versioning/pinning is deferred: the next activity render reads the editable prompt as today.

Prioritize a narrow oversight slice before the larger [delegated child work](delegated-child-work.md) implementation. Oversight selects where effort goes; a parent coordinates how a particular delivery is completed. The first slice works with existing single-flow WorkItems and does not depend on hierarchy, stacks or joins. The historical [architecture report](../reports/2026-10-10-architecture-recommendation-review.md) still recommends prompt/process refinement as its first response to the observed refinement/review problems; this proposal addresses the subsequently identified work-selection need.

## 2. Existing foundations and gaps

| Foundation at the baseline                                      | Reuse                                                     | Gap                                                                                                                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control Plane schedules with `workflow`, `cron` and `objective` | Ordinary scheduled workflow starts                        | No configurable capacity/backlog/focus condition trigger                                                                                                      |
| Eventing activation scheduler and bounded advancement           | React to durable observations and reconcile after restart | Oversight-specific eligibility, coalescing and single-flight recovery                                                                                         |
| Dispatch limits, concurrent-run checks and dispatch policy      | Deterministic dispatch enforcement                        | Current policy orders candidates by requested position; no durable goal-aware ranking                                                                         |
| WorkItem objectives and revisioned artifacts                    | Workflow context and assessment memory                    | Explicit oversight-scope memory and focus lifecycle                                                                                                           |
| `prompts/triage-assign.md`                                      | Existing intent to inspect backlog and choose work        | A repository prompt is not proof of production composition; its direct `gh` assignment and template variables do not establish this proposed command boundary |

The uploaded architecture reassessment recommends bounded supervision, goals and reprioritising ready work. The managed-session proposal also lists supervisor priority commands. Neither establishes the complete capacity-triggered selection contract below. The existing child-work spec concerns coordination within a delivery, rather than selection across the backlog.

## 3. Behavior

An oversight scope identifies allowed repositories/backlog sources, its configured workflow, authority and budgets. It may have a current delivery focus with an objective and explicit constraints. Without a focus, configured general triage criteria apply.

An ordinary run follows this sequence:

1. A configured canonical event or cron occurrence requests evaluation. Eligibility alone does not request a run.
2. The deterministic trigger policy checks whether evaluation is useful and permitted. It coalesces pending reasons and creates at most one active oversight workflow per scope.
3. The workflow receives a bounded snapshot of candidate work, active deliveries, capacity, focus revision and previous decision/assessment references.
4. The agent reads GitHub, prior memory and current focus, then assigns at most one suitable issue through `gh`, or records a reasoned no-op. It checks current provider state before repeating an assignment after interruption. Known necessary human questions are consolidated rather than asked one candidate at a time.
5. Normal GitHub observations and intake correlate the assignment with one WorkItem, applying current admission limits. Assignment requests work; it does not reserve capacity or guarantee immediate admission/dispatch. The assessment artifact identifies the selected issue, rationale and observed provider result.
6. The run records assessment context for the next evaluation and finishes. A relevant change during the run causes a later coalesced evaluation if still useful.

No suitable work is a successful no-op. A later explicit cron/event occurrence may reconsider it after cooldown; the no-op itself does not request another evaluation. Errors follow bounded workflow retry policy. Reconciliation must not reset an exhausted retry budget indefinitely.

## 4. General trigger mechanism

### 4.1 Configuration contract

The proposed strict `controlPlane.triggers` list replaces scheduled-task definitions with trigger-to-workflow entries. Reuse the existing watch vocabulary where useful, but place event and time sources together under `on`. A target remains a named workflow plus an objective; this does not introduce a separate action engine.

```yaml
controlPlane:
  triggers:
    - id: delivery-oversight
      on:
        events:
          - execution.run-succeeded
          - execution.run-failed
          - execution.run-cancelled
        cron: "*/5 * * * *"
      when:
        capacityAvailable: true
      workflow: delivery-oversight
      objective: Inspect GitHub and assign suitable work.
      contextScope: oversight-main
      minIntervalMs: 300000
```

The event names above already exist. The surrounding trigger schema is proposed, not current configuration. They are wake-up hints: a Run ending does not prove that delivery capacity is still available. Cron is the explicit fallback for already-idle systems or backlog outside Wake's intake filters; broad backlog reads happen in the agent.

| Field                    | Proposed contract                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `id`                     | Required unique trigger identity; owns checkpoints/cooldown and default coordination key                     |
| `on.events`              | Optional non-empty list of known canonical event types; validate against registered public vocabularies      |
| `on.cron`                | Optional five-field UTC cron expression; preserve current expression semantics                               |
| `on`                     | Required; at least one source must be present. Events and cron are alternative sources, not an AND condition |
| `when.capacityAvailable` | Optional true-only typed execution-headroom gate; all configured gates must hold                             |
| `workflow` / `objective` | Required named workflow and new invocation WorkItem objective, as with current schedules                     |
| `contextScope`           | Optional reference to a configured Artifact context scope; a reference alone grants no access                |
| `minIntervalMs`          | Optional non-negative cooldown between workflow starts; default 0; oversight example sets five minutes       |

For this first release, `capacityAvailable` means execution headroom under the configured `maxConcurrentRuns`, with normal pause/runner eligibility checks. It is a typed policy gate, not a generic metric. Recheck it before starting; it does not reserve capacity or prove that another delivery should be admitted. The agent considers active work and chooses whether to assign anything. Delivery WIP is a distinct future policy (existing backlog issue #148), not a prerequisite for the trigger engine. Normal dispatch enforces execution capacity for all Runs, including oversight itself. Trusted trigger provenance distinguishes oversight invocation WorkItems from deliveries if root-delivery accounting is later added. Additional gates can be introduced as typed policy contracts when needed.

Events-only, cron-only and combined entries are supported. Missing/empty `on` is a configuration error. There is no implicit startup trigger, condition-only trigger, or run on a false-to-true gate change. A future startup trigger requires an explicitly defined and subscribed canonical event. Recovery of an already-recorded request is distinct from creating a startup request.

Interval scheduling is a future source format; it does not alter the source/gate/target separation. If added, it can sit alongside `events` under `on`, with at most one time source per entry. Arbitrary metric expressions, JavaScript conditions and payload-query languages are out of scope.

### 4.2 Eligibility, cooldown and recovery

A false `when` skips that occurrence and advances its consumed checkpoint. It does not wait for capacity and fire later. The next explicit occurrence can try again. Deferred-on-ineligibility behavior is not in the first release.

Requests received during cooldown or an active invocation are coalesced into at most one pending request per coordination key. Wake may start that recorded request after cooldown/the active invocation ends, but must recheck `when`. Cooldown expiry without a pending explicit request does nothing. Measure cooldown from the recorded workflow start; skip does not consume cooldown, and no-op completion does not bypass it. A long active run still prevents overlap even if its cooldown elapsed.

Persist source identities (event ID or cron slot), consumed checkpoint, last start, pending request and active invocation. Replaying events, restarting hosts, or issuing simultaneous tick/resident advancement must not duplicate a start. Remove `controlPlane.schedules`; reject that old schema and update the init scaffold/current reference docs. No compatibility aliases, schedule-state migration or dual paths are required. For new triggers, start event consumption at registration rather than replaying the entire journal. After registration, checkpoint recovery may catch up unseen events/cron slots using bounded coalescing; a previously recorded request is not silently lost.

The first implementation uses existing shared-home serialization/claims. Use the trigger ID as the default coordination key and the context-scope identity when a scope is bound, so two triggers targeting the same oversight memory cannot overlap. Separate triggers targeting the same workflow without shared context remain independent. Define claims durably, not with process-local flags. Distributed multi-server coordination/fencing beyond the existing shared-home topology is deferred.

Exclude events produced by that oversight scope's own invocations from its evaluation requests. This avoids a completion-trigger loop; a cooldown alone would merely slow it down. Keep retries within existing workflow budgets. Surface exhausted failures and pause the trigger until an explicit operator resume; a cron occurrence must not silently reset an exhausted invocation's retries.

Oversight uses normal execution limits and never reserves all delivery slots while deliberating. Configured runner pools can separate its execution from implementation work; the first release does not promise preemption or additional global capacity.

## 5. Invocation identity and operator controls

Each occurrence that starts creates an independent top-level WorkItem and ordinary workflow instance. A trigger is a recurring control-plane definition, not a synthetic parent WorkItem. Invocation facts record trigger ID, source identities, invocation WorkItem/workflow, context scope and start/result references. A triggered invocation may itself delegate real children later; that does not make successive occurrences siblings under a synthetic work parent.

Add a **Triggers** page to the main Wake navigation. List configured trigger ID, effective enabled/paused/running status, target workflow, next cron occurrence where applicable, last invocation and skip/failure reason. The detail page shows configuration, pending request/cooldown, linked invocation history and the bound context scope. WorkItem pages link back to their originating trigger. A cron-only trigger has a next time; an events-only trigger does not invent one.

Pause/resume are available on the list row and detail page through typed Control Plane commands/API. Pause durably prevents new starts and clears any unstarted coalesced request. While paused, consume/skip incoming occurrences without accumulating catch-up work. Resume permits subsequent explicit occurrences; it does not immediately start a run, replay paused occurrences, or reset invocation retry counters. Existing active invocations continue; cancel/freeze stays an explicit existing WorkItem action. Recheck pause immediately before registering a start and serialize that decision with pause application. Keep command receipts/recovery inspectable.

Config remains authoritative for definitions; durable pause state controls operation without rewriting YAML. Changing a definition under the same ID affects future starts, not the running workflow's pinned definition. Removing a trigger prevents future starts; recorded history remains inspectable and active WorkItems remain independently manageable. A rename creates a new trigger identity. Pause should survive remove/re-add of the same ID unless explicitly reset.

## 6. Artifact context scopes and focus

### 6.1 One sharing mechanism

A context scope is an Artifact-owned collection of authorized artifact references, not a second byte store, conversation store or an indefinitely open WorkItem. Artifacts retain existing WorkItem identity, producer-owned writes, revision provenance and accepted-output publication. A scope adds read access and named current references across separate WorkItems.

Triggered WorkItems bind to a configured stable scope such as `oversight-main`. Delegation can create a delivery scope and enroll related WorkItems through the trusted delegation command. The same sharing contracts cover both cases:

| Consumer                  | Default shared references                                                    |
| ------------------------- | ---------------------------------------------------------------------------- |
| Next oversight invocation | Current accepted memory and selected prior assessment references             |
| Delegated child           | Parent context explicitly supplied in its assignment                         |
| Coordinating parent       | Accepted artifacts from its registered children                              |
| Dependent child           | Explicit prerequisite result/context references                              |
| QA/reviewer               | Candidate specifications/change evidence explicitly supplied to its activity |

Children cannot edit parent or sibling artifacts. A parent can read accepted child artifacts but cannot edit them either. Siblings do not gain automatic read access; ancestry alone is not an unrestricted artifact grant. Failed/unaccepted drafts are private unless an explicit recovery grant is issued. No general configurable ACL language is required for this release.

### 6.2 Current memory and publication

Each invocation reads the scope's current accepted memory, then writes a successor `memory.md` under its own producer. An accepted outcome from the configured publishing stage advances the scope's `memory` reference to that revision. An absent file, failed activation or unaccepted draft leaves the previous reference unchanged. Keep provenance/history; replacing a current pointer never deletes the old producer's artifact. Published references must remain retained while reachable by scopes or recorded delivery evidence.

Use exact revisions for assignments and review evidence. For recurring memory, resolve the current reference when provisioning each Run's manifest. This does not freeze the editable prompt. Expected prior-reference checks prevent two competing publishers from silently overwriting current memory; single-flight coordination is the ordinary prevention mechanism. Advancing a scope reference follows accepted-outcome facts and reconciles idempotently after a crash, without assuming an atomic append across module streams.

The context manifest contains metadata/references, not every historical transcript. Later runs can explicitly read authorized supporting artifacts. A no-op may publish useful updated assessment memory if its outcome is accepted. Keep trigger checkpoints/claims as operational state, not prose inside memory.

### 6.3 Configuration and encapsulation

The following proposed Artifact-owned scope definition is illustrative of the strict contract to implement; it does not exist at the baseline:

```yaml
artifacts:
  contextScopes:
    oversight-main:
      workflows:
        - delivery-oversight
      bindings:
        memory:
          workflow: delivery-oversight
          stage: assess
          path: memory.md
```

`workflows` declares permitted workflow definitions for triggered membership. `bindings` declares which named workflow/stage may publish a producer-owned artifact as a current scope reference; the example requires that stage actually to exist. A trigger's `contextScope` is only a reference: Bootstrap validates the target workflow against the Artifact-owned scope contract. A workflow name by itself does not enroll arbitrary WorkItems. Membership capabilities are issued using trusted trigger/delegation provenance; a tool argument cannot self-enroll a Run. Writes continue through existing artifact tools, not a new shared-write tool.

Artifacts owns access decisions, memberships, current references, retention and MCP semantics. It consumes generic trusted producer/acceptance evidence through public ports; it does not import workflow internals or infer parenthood. Orchestration supplies accepted-outcome/delegation facts; Control Plane supplies trusted trigger binding; Bootstrap composes and validates the graph. Keep references to concrete scope identifiers out of generic workflow-transition interpretation. Surfaces read owning projections and invoke public commands.

An operator can supply/update a delivery focus through a referenced artifact or configured activity input. Include its consumed revision in the assessment. The agent may suggest a different focus but does not silently redefine it. Changing focus influences future evaluations and does not cancel active work. A separate goal lifecycle service and automatic reprioritization of all admitted work are deferred.

## 7. GitHub selection and dependencies

The first oversight workflow reads configured repositories and assigns at most one eligible issue to Wake through `gh`. Record the issue reference, reasons, focus/memory revisions and observed assignment result in its assessment artifact. Provider assignment is an external request, not an atomic Wake admission command. Polling/intake retains canonical correlation/idempotence; execution dispatch rechecks its existing gates.

Read native GitHub blockers where available and use them in deciding whether work is ready. If prerequisite completion is ambiguous, investigate rather than equating any closed issue with available implementation. For code prerequisites, prefer evidence that the required implementation has merged/exists on the intended base. Do not assign a known blocked issue merely because execution slots are free. Explicit issue-body dependencies remain useful context if native data is absent.

Dependency readiness and priority remain distinct: the agent selects the best useful candidate from work it believes ready. Native dependency enforcement across all intake paths is tracked separately in existing issue #499 and later Wake dependency work; the first oversight release does not claim a hard dependency guarantee for manual/other intake. GitHub relationships on this delivery batch document ordering but do not auto-dispatch the next issue in today's Wake. Only ready issues are assigned for execution.

After interruption, inspect provider state before repeating assignment. Reassigning an already-assigned issue does not create another Wake WorkItem. If assignment succeeded but no assessment was published, recover observable provider state and record it; do not promise a distributed exactly-once transaction between `gh`, artifacts and the journal. A failure must not broaden repository/merge/lifecycle authority. Normal retries remain bounded.

Existing queued delivery work may deserve effort before admitting more work. Distinguish execution slots from delivery WIP; the first activity can use active-work context to choose a no-op. Hard WIP enforcement, richer ready-work priority commands and native dependency ingestion are follow-on policies, not hidden prerequisites for the trigger mechanism. Existing #406 covers an older gating proposal; this specification defines the new schema/semantics rather than implementing its superseded config verbatim.

## 8. What stays, changes and goes

| Existing part                                                          | Treatment                                                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Control Plane ownership, Eventing processors/journal, production hosts | Keep; extend the existing advancement/composition path                                               |
| Scheduled creation of WorkItem plus named workflow                     | Reuse as the invocation start path, with durable trigger provenance                                  |
| `controlPlane.schedules` / schedule-only schema                        | Replace with one `controlPlane.triggers` schema; remove old config and paths, no compatibility layer |
| Cron evaluation/checkpoints                                            | Reuse useful implementation; adapt identities to trigger-owned occurrences                           |
| Workflow watches                                                       | Keep parent-scoped behavior; reuse canonical vocabulary without treating oversight as a parent watch |
| Workflow/stage execution and runner limits                             | Keep; no new execution engine or autonomous transition interpreter                                   |
| Artifact storage/revisions/MCP and producer ownership                  | Keep; add context scopes, memberships and cross-WorkItem read references                             |
| `triage-assign` intent                                                 | Update/configure for real trigger/context input and dependency-aware GitHub selection                |
| UI/API                                                                 | Add Triggers list/detail and pause/resume; link existing WorkItem pages to origin                    |

Control Plane owns trigger definitions/requests, eligibility and pause; Work owns invocation WorkItem lifecycle; Orchestration owns ordinary workflows and accepted outcomes; Artifacts owns context sharing. Integrations owns normal GitHub observations/intake. Bootstrap owns composition and cross-reference validation. No module gains permission to reconstruct another module's events or import private implementation paths.

## 9. Proposed acceptance scenarios

These IDs describe proposed coverage, not scenarios already implemented or registered in Wake's catalogue.

| ID    | Behavior to prove                                                                            |
| ----- | -------------------------------------------------------------------------------------------- |
| DO-01 | Cron/event sources independently request one ordinary invocation when eligible               |
| DO-02 | Duplicate observations, concurrent shared-home hosts and restart do not duplicate starts     |
| DO-03 | Requests during active/cooldown periods coalesce to one pending explicit request             |
| DO-04 | No-op succeeds; only a later explicit source can request another evaluation                  |
| DO-05 | Current capacity/pause gates are rechecked before starting; false eligibility skips          |
| DO-06 | Actual dispatch still enforces execution limits after an earlier trigger check               |
| DO-07 | No implicit startup/condition-only execution; missing `on` and legacy schedules are rejected |
| DO-08 | A fresh invocation reads accepted memory from an explicitly authorized context scope         |
| DO-09 | Wrong-scope reads, self-enrollment and cross-producer writes are denied                      |
| DO-10 | Interrupted GitHub assignment recovers by observing provider state without duplicate intake  |
| DO-11 | Paused triggers skip sources/clear pending work; active invocations continue                 |
| DO-12 | Oversight's own completion events do not request another oversight run                       |
| DO-13 | Invocation history and WorkItem origin links remain inspectable after restart/removal        |
| DO-14 | Parents read accepted child artifacts; children/siblings get only declared context           |
| DO-15 | Failed/draft output does not advance memory; accepted publication reconciles once            |
| DO-16 | Exhausted failures pause the trigger rather than silently regenerating retries               |
| DO-17 | Agent triage reads available GitHub dependency evidence and does not assign known blockers   |
| DO-18 | Referenced artifacts remain retained and stale current-memory updates are rejected           |

Use permanent fake adapters/composed flows for cron, events, claims, artifacts and provider recovery. Each slice owns meaningful focused tests; UI/API work includes relevant surface coverage. No live model tokens are needed to prove orchestration correctness. A later bounded agent trial evaluates selection quality and cost.

## 10. Delivery slices

Five GitHub delivery issues implement this scope. Keep intended outcomes separate from suggested implementation; do not dispatch dependent issues before prerequisite implementation is available. O4 can proceed independently; only O1 is dispatched initially per operator instruction.

| Slice | GitHub issue                                         | Blocked by                      |
| ----- | ---------------------------------------------------- | ------------------------------- |
| O1    | [#889](https://github.com/atolis-hq/wake/issues/889) | None                            |
| O2    | [#890](https://github.com/atolis-hq/wake/issues/890) | #889                            |
| O3    | [#891](https://github.com/atolis-hq/wake/issues/891) | #890                            |
| O4    | [#892](https://github.com/atolis-hq/wake/issues/892) | None; held unassigned initially |
| O5    | [#893](https://github.com/atolis-hq/wake/issues/893) | #890 and #892                   |

### O1. Trigger configuration and sources

**Outcome:** users can configure independent workflow starts from explicit cron/events through one strict trigger schema.

Replace schedules with triggers, preserve five-field UTC cron semantics, validate canonical events and named workflow/objective, support the closed capacity gate shape and trigger-level cooldown fields, and wire the minimal production start path. No `on` means invalid config; no implicit startup. Remove old schema/paths, update init scaffold and current config/workflow reference docs. Context scope field has an Artifact-owned reference contract; full sharing lands in O4. Prove cron-only/event-only/combined invocation creation and origin identity with composed fakes.

**Unlocks:** reusable sources and a concrete foundation for other recurring jobs. **Depends on:** none of this batch.

### O2. Durable trigger execution

**Outcome:** triggers start work safely under live capacity, overlap, pause and restart conditions.

Implement durable requests/checkpoints, current capacity validation, cooldown/coalescing, single-flight claim, typed pause/resume commands and invocation history projections. Suppress self-triggering loops; pause on exhausted failures. Prove duplicate input, competing hosts, crash windows and skip/cooldown semantics. Preserve existing dispatch limits and use public contracts rather than a new scheduler.

**Unlocks:** unattended reliable recurring execution and the API facts needed by UI. **Depends on:** O1. Covers the current intent of existing #406 without its historical schema/defaults.

### O3. Trigger controls and UI

**Outcome:** operators can find, inspect and pause/resume recurring jobs from a dedicated Triggers page.

Add list/detail navigation, status, next cron time, cooldown/pending state, invocation history, origin links and pause/resume actions. Expose clear skipped/failed reasons and active WorkItem links. Pausing leaves active work running; cancellation stays an existing WorkItem action. Include focused API/web coverage for command races/errors and navigation.

**Unlocks:** operational control and explainability. **Depends on:** O2.

### O4. Shared artifact context

**Outcome:** distinct WorkItems can share selected accepted artifacts across recurring invocations and future delegated delivery.

Implement Artifact-owned named scopes, trusted memberships, exact-revision read references, accepted memory bindings and producer-only writes. Validate permitted workflow/stage bindings in composition. Prove fresh-session handoff, denial of unrelated/draft reads, stale pointer updates, accepted-publication recovery and reference retention. Provide the generic trusted-parent/child sharing contract without building the delegated workflow engine.

**Unlocks:** cross-invocation memory and reusable parent/child artifact handoff. **Depends on:** none of this batch; integration uses O1/O2 when available. Actual child enrollment later uses validated delegation.

### O5. Delivery oversight workflow

**Outcome:** an explicitly triggered agent checks GitHub, uses shared context/focus and assigns one useful ready issue or records a no-op.

Configure the ordinary workflow/editable prompt, GitHub read/assignment capability and memory publisher stage. Use available native dependencies and explicit issue-body prerequisites as decision evidence. Do not require a new global goal service or dependency engine. Prove the composed fake-provider path through triggering, artifacts, assignment, normal intake and recovery. Report why no candidate was selected and ensure unready downstream delivery issues remain undispatched.

**Unlocks:** autonomous selection on today's single-flow WorkItems. **Depends on:** O2 and O4. O3 improves operation but is not an execution dependency.

## 11. Deferred scope and behavioral tradeoffs

Defer interval scheduling, distributed multi-server fencing beyond existing shared-home coordination, arbitrary expression/ACL languages, prompt pinning/versioning, autonomous goal rewriting, forced agent interruption and a general strategic planning service. Hard provider-dependency ingestion/enforcement remains existing #499; queue WIP remains #148. Child workflows remain the companion spec's scope. Do not add compatibility machinery for schedules.

Agent triage permits judgment where GitHub data is incomplete, but is not a substitute for later deterministic dependency enforcement. Assess completion, useful selection, interruptions, active-work age and spend; occupied slots alone are not success. Native issue closure is evidence, not universal proof that prerequisite code is available. Keep typed execution gates and inspectable assessment provenance.

The implementation is custom extensions to Wake's existing modules; no LangGraph adoption or persistent supervisor session is required. Prompt/process refinement remains useful where needed. This five-slice oversight release can precede the larger delegated-work implementation without becoming a prerequisite for its domain semantics.
