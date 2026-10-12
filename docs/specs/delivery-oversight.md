# Spec: triggered delivery oversight

**Status:** proposed, ready for review; behavior is not implemented by this document.
**Date:** 2026-10-12.
**Implementation baseline:** `d58d99154cd936b95b461c320e45b39a1b4423da`.
**Scope:** bounded condition/interval-triggered agent workflows, durable context across runs, backlog admission and goal-aware delivery selection.

## 1. Intended outcome and recommendation

Wake should choose useful work when capacity permits, using either general triage or an operator-defined delivery focus. Selection should adapt when that focus changes, survive restarts, and favor completing valuable deliveries rather than merely keeping every agent busy.

**Recommended approach: add a small, reusable trigger mechanism to Wake's existing workflow engine and implement delivery oversight as an ordinary configured workflow.** Keep trigger eligibility, admission, capacity checks and dispatch deterministic. Use an agent activity for judgments such as comparing candidates against a goal. Record decisions through typed domain commands rather than having the agent directly assign issues or start runner sessions.

Memory is durable context, not a requirement for one persistent agent session. Reuse canonical artifacts for assessment notes and handover. Record operational focus, decision receipts and selection facts in the owning event namespace, with rebuildable projections. A new agent session must be able to continue correctly from those records.

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

1. Wake observes a relevant backlog, capacity or focus change, or a fallback interval elapses.
2. The deterministic trigger policy checks whether evaluation is useful and permitted. It coalesces pending reasons and creates at most one active oversight workflow per scope.
3. The workflow receives a bounded snapshot of candidate work, active deliveries, capacity, focus revision and previous decision/assessment references.
4. The agent investigates candidates if needed, then submits a bounded selection or a reasoned no-op. It can return several ranked candidates within the configured limit; this is not one human question per candidate.
5. Wake validates the command, records the decision and applies permitted admission or priority effects. Normal intake and dispatch enforce current eligibility and capacity.
6. The run records assessment context for the next evaluation and finishes. A relevant change during the run causes a later coalesced evaluation if still useful.

No suitable work is a successful no-op, not an instruction to invent work or repeatedly poll with an agent. Errors follow bounded workflow retry policy; periodic reconciliation must not reset an exhausted retry budget indefinitely.

## 4. General trigger mechanism

Support configured intervals and a small set of typed condition predicates initially: eligible backlog exists, admission headroom exists, relevant capacity becomes available, and focus changes. These are proposed concepts, not existing schema keys. Condition inputs come from owning modules' public read contracts.

Do not expose arbitrary JavaScript expressions, arbitrary event payload queries or an agent-authored workflow engine. A condition change requests evaluation; it does not grant authority to mutate work. The same mechanism can later host other operational workflows if they use defined conditions and ordinary activity contracts.

For each scope, persist the evaluation request identity, coalesced reasons, relevant input revisions and active workflow reference. Intervals use durable slot identities. Replaying an event, restarting the resident host, or running simultaneous tick/resident hosts must not create duplicate evaluations.

Use a minimum evaluation interval and bounded pending state. Backlog notifications that do not affect the eligible candidate set should not repeatedly spend tokens. A fallback interval catches missed observations and allows time-sensitive policy to be reconsidered. Once a run completes, an unchanged no-op snapshot waits for a relevant change or its configured reconsideration time.

Oversight consumes execution capacity too. Its admission must use an explicit bounded control-work budget under existing execution limits, so it cannot recursively trigger itself because it occupied or released a slot. Initially allow one control evaluation at a time and make any priority over delivery activities explicit. An oversight run does not reserve all delivery slots while it deliberates.

## 5. Admission, dispatch and work in progress

Distinguish two decisions:

- **Admission:** which eligible external backlog items become active Wake deliveries.
- **Dispatch preference:** which ready activity from admitted work should receive available execution capacity.

Run capacity and delivery work-in-progress limits are different. A delivery waiting for review or a human can consume no Run slots while still being unfinished work. A free slot alone must not continuously admit new deliveries. Define a configurable root-delivery WIP limit and deterministic accounting before enabling automatic admission. Until delegated hierarchy exists, apply that limit to admitted single-flow WorkItems; later children count under their root delivery rather than each becoming a new portfolio slot.

Prefer progressing valuable existing deliveries when useful work is ready. A blocked delivery may justify admitting another within WIP policy. The agent proposes relative priority with reasons; the scheduler still applies dependencies, freezes, approvals, runner limits and workspace eligibility. Preserve deterministic tie-breaking and a configured aging/fairness policy so repeated focus decisions cannot silently starve other eligible work.

A selection command is not a capacity reservation. Recheck admission headroom at the intake boundary and execution capacity at dispatch. When headroom has disappeared, record a deferred or rejected effect with a reason rather than creating excess active deliveries. Other intake paths must share the relevant admission policy; an oversight-only limit is insufficient. Explicit operator overrides, if supported, are distinct audited commands.

An agent can propose bounded admissions and ordering in one evaluation. It cannot revise ticket objectives, bypass approval, merge PRs, cancel active work or broaden its allowed repositories unless separately authorized by a defined command and policy.

## 6. Focus and memory across runs

Keep a stable oversight scope and a revisioned current focus. A focus includes objective, source/actor, effective revision, constraints and optional expiry. Changing it is an authorized operator action in the first release. The oversight agent may suggest a change through an artifact but cannot silently redefine the goal.

Every accepted selection records the focus revision and input references it evaluated, selected candidates, reasons, actor/Run identity and effect receipts. Historical decisions remain inspectable after a focus change. If the focus changes during evaluation, reject priority/admission mutations based on the superseded focus and request reevaluation. Changes to ordinary capacity are handled by revalidation rather than automatically discarding the entire assessment.

Focus changes affect queued selection and future admission. Existing active work continues by default. Pausing or abandoning it requires an explicit lifecycle decision; otherwise the system may spend effort repeatedly starting and discarding partially completed work.

Use revisioned artifacts for candidate comparisons, prior investigations, assumptions and handover notes. Keep these scoped to the oversight owner, with explicit read access for subsequent evaluation WorkItems. Do not assume current same-WorkItem artifact visibility automatically covers separate triggered runs. Writes remain owned and auditable; a later run receives accepted revisions and any explicitly recoverable draft context.

Operational facts must not depend on prose interpretation. Focus revisions, accepted decisions, command receipts and trigger recovery state have typed contracts. Projections derive domain facts; processor-owned trigger recovery uses processor state. Do not substitute a mutable artifact for either source of truth.

## 7. Commands, recovery and authority

An illustrative selection command carries a stable request identity, expected focus revision, ordered candidate references with observed revisions, proposed admission/priority effects and reasons. Wake injects trusted scope, actor, Run and authority context. MCP is one transport to the same command service used by other callers.

Candidate identity must resolve through typed Resource/Work contracts. External backlog observations remain untrusted integration input. Intake uses stable correlation identity so two decisions or an external assignment cannot create duplicate WorkItems for the same source.

Accepting a decision and creating a WorkItem may touch different streams. Do not assume cross-stream atomic append. Persist a decision intent, reconcile each permitted effect with stable command identities, and record effect receipts. A crash after intake but before receipt recovery must discover the existing item rather than admit it again. Accepted assessments and successfully applied effects remain distinguishable.

Scope-level selection application must serialize or use an equivalent optimistic concurrency contract with deterministic admission accounting. Single-flight oversight alone does not protect against other intake sources. Stale or unauthorized decisions are rejected explicitly; they do not become permission to retry with wider authority.

The workflow can use existing bounded retries and structured activity outcomes. A failed agent run does not erase accepted effects. Reconciliation handles recorded effects independently of another agent invocation.

## 8. Ownership and implementation choice

| Owner                          | Proposed responsibility                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Control Plane                  | Trigger eligibility/coalescing, scope focus and selection policy facts, admission accounting, priority interpretation and reconciliation |
| Work                           | Existing WorkItem creation/lifecycle and, later, hierarchy semantics                                                                     |
| Resources / Integrations       | Candidate correlation, provider observations and outbound delivery through existing boundaries                                           |
| Orchestration                  | Ordinary oversight workflow instances, activities, waits and bounded routes                                                              |
| Activities / Execution         | Typed evaluation input/output and bounded runner attempts; no authority to decide dispatch directly                                      |
| Integrations artifact services | Revisioned assessment context, owner scoping and explicit cross-run access grants                                                        |
| Bootstrap / Surfaces           | Composition, strict configuration, operator focus updates and explainable status                                                         |

Use exported module contracts and existing Eventing adapters. Establish owning event/stream vocabulary and decoders before persisting new facts. Keep root-delivery policy in Control Plane; do not infer hierarchy from arbitrary relation strings in surfaces.

Custom extensions to Wake are the recommended implementation. LangGraph or a continuously running supervisor is unnecessary for this slice: the missing behavior is trigger, policy and durable command composition around an existing activity runtime. Session resumption is optional execution context, not the recovery model.

## 9. Proposed acceptance scenarios

These IDs describe proposed coverage, not scenarios already implemented or registered in Wake's catalogue.

| ID    | Behavior to prove                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------- |
| DO-01 | Eligible backlog and admission headroom cause one ordinary oversight workflow                              |
| DO-02 | Duplicate signals, concurrent hosts and restart do not create duplicate active evaluations                 |
| DO-03 | Changes during evaluation are coalesced and reconsidered after completion                                  |
| DO-04 | No candidate produces a successful no-op without repeated identical agent invocations                      |
| DO-05 | Free Run capacity with exhausted delivery WIP does not admit another delivery                              |
| DO-06 | Capacity changes during evaluation cannot cause excess admission or dispatch                               |
| DO-07 | A changed focus rejects stale mutation and preserves decision history                                      |
| DO-08 | A fresh agent session receives prior accepted assessment context                                           |
| DO-09 | Out-of-scope candidates and unauthorized lifecycle/objective mutations are rejected                        |
| DO-10 | A crash between accepted intent, intake and receipt recovers effects exactly once                          |
| DO-11 | Already admitted work, freezes, approvals and runner limits remain enforced                                |
| DO-12 | Oversight execution cannot recursively trigger an unbounded evaluation loop                                |
| DO-13 | Configured fairness prevents indefinite starvation while preserving focus preference                       |
| DO-14 | Child work later shares its root's portfolio priority/WIP identity without occupying additional root slots |
| DO-15 | Focus change does not implicitly cancel or discard active work                                             |
| DO-16 | Bounded failures remain bounded across fallback evaluations and process restarts                           |

## 10. Delivery slices

These are issue-ready slices, not filed or dispatched issues. Each issue should retain its intended outcome separately from the suggested implementation. Use permanent fake adapters and composed recovery tests before enabling autonomous provider effects.

### O1. Durable focus and selection command boundary

**Outcome:** evaluations can explain and persist what they recommend against a known focus without mutating provider state.

Define scope/focus revisions, candidate references, decision intent/effect status, command identity and authority. Support general triage with no active focus and explicit operator focus changes. Reject stale focus and unauthorized actions. Initially keep decisions advisory. Prove replay and fresh-session context construction with typed fake candidates.

**Unlocks:** auditable goal-aware recommendations and safe future automation. **Depends on:** existing Work/Resource and Eventing contracts, not child workflows.

### O2. Minimal recurring oversight and artifact continuity

**Outcome:** an ordinary configured workflow evaluates backlog periodically and reuses previous assessments.

Reuse current schedule entry points; add scope-level single-flight reconciliation, bounded candidate input, accepted artifact references/read grants across runs, evaluation budgets and no-op cooldown. Exercise two runs with different sessions and restart between them. Establish the explicit control-work execution budget.

**Unlocks:** useful advisory oversight before condition triggers or automatic admission. **Depends on:** O1.

### O3. Guarded admission and ready-work preference

**Outcome:** authorized selections actually choose work while respecting delivery WIP, capacity and existing lifecycle gates.

Implement shared admission accounting and idempotent correlation, decision-effect reconciliation, bounded priority application, deterministic tie-breaking and fairness. Revalidate actual effects; show deferred/rejected reasons. Prove concurrent intake and crash recovery. Automatic provider assignment, if needed, uses Integration delivery rather than an unrestricted `gh` mutation from the prompt.

**Unlocks:** autonomous backlog selection and better progress on existing deliveries. **Depends on:** O1 and O2. This is the first operational release; O2 alone is advisory.

### O4. Condition triggers and event coalescing

**Outcome:** oversight reacts to useful changes without waiting for a polling interval or invoking an agent for every event.

Add a closed set of typed trigger conditions, durable evaluation requests, input watermarks and reconciliation. Keep interval fallback. Test concurrent hosts, changes during a run, unchanged backlog and self-trigger suppression. Preserve exhausted retry budgets rather than minting a new failing evaluation on every tick.

**Unlocks:** responsive selection with bounded token use. **Depends on:** O2 and O3.

### O5. Parent-delivery integration and operator visibility

**Outcome:** oversight allocates effort across complete deliveries, including their children, and operators can understand its decisions.

Connect root-delivery accounting and inherited portfolio preference to validated child hierarchy once available. Distinguish portfolio priority from dependency readiness and per-stack serialization. Present current focus, active WIP, pending evaluations, decisions, effect failures and no-op reasons. Test that a large decomposition cannot gain priority merely by creating more children.

**Unlocks:** coherent prioritization across multi-repository delivery and actionable operator oversight. **Depends on:** O3/O4; child accounting additionally depends on delegated-work hierarchy. Basic decision diagnostics ship with earlier slices.

## 11. Tradeoffs and deferred scope

The agent can compare ambiguous work and changing goals better than a fixed queue policy, but introduces cost and variation. Retain a deterministic fallback order and evaluate selection quality, completion rate, WIP age, useful idle time and spend. Occupied slots alone are not a success metric. The expected benefit is a design hypothesis until observed on Wake's actual backlog.

Defer autonomous goal rewriting, unrestricted graph restructuring, forced interruption of active agents, arbitrary condition languages and a general strategic planning service. A future recovery supervisor may reuse triggers and scoped commands, but it is not required for delivery selection.

Recommended sequencing is prompt/process refinement where needed, O1-O3 for a narrow operational oversight release, then the delegated-work vertical slice. O4 can follow based on latency/cost observations; O5 joins the capabilities. Oversight is an earlier useful increment, not a mandatory prerequisite for implementing child-work domain semantics.
