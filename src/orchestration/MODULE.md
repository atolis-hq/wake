# orchestration

## Purpose

Configured workflow interpretation and durable instances.

## Owns

Definitions, compilation, instances, activations, waits, child workflows,
watches, outcomes, retry policy, orchestration-owned processor handlers, and
live work-completion metrics derived from primary workflow facts.

## Does not own

Agent invocation, workspaces, provider polling, delivery, global selection,
Eventing host construction, or concrete serialisation.

## Invariants

Interpretation is deterministic; each WorkItem has one active primary workflow
and children remain linked to its group. Persisted events are decoded before
folding. Watch and resource-transition processors use stable consumers and
idempotent handlers; watch recovery remains a separate reconciler with its own
checkpoint.

`listPendingActivations` attaches a dispatch priority to each pending
activation: remaining agent steps (minimum agent-running stages on a route to a
terminal stage, from the compiled graph and activity `executionKind`; stages
that cannot finish rank last), `watchDriven` (the typed `watchDriven` flag on
the activation, set when a watch verdict or resource transition resumed the
stage), and `retried` (the stage has a retry count above zero). Orchestration
reports these; Control Plane orders by them. Historical definitions without
compiled costs count removed activities conservatively as agent steps.
Resource-transition origin remains explicit even on a watch-verdict channel;
quota re-requests preserve that activation origin without counting a retry.

Delegated work (`DelegatedWork`) starts independent child WorkItems with their
own primary workflow, separate from same-WorkItem watch children. A
`delegation-reserved` event on the root's primary workflow stream is the single
commit point (identities, pinned workflow fingerprints, root-wide depth and
descendant limits). Wait, WorkItem, claim, artifact grant, child start, result
selection and join are reconciled idempotently from it. The parent is fenced
from ordinary advancement until `delegation-joined` or terminal `delegation-failed`; a child qualifies only when
its workflow reached configured terminal completion without a failure outcome and every required named output resolves to
an accepted exact artifact revision. Run-scoped production commands enforce opt-in workflow policy and Bootstrap-supplied Run/repository authority. Delivery-wide limits are recorded on root reservations. Work ancestry gates dispatch, outcomes and continuation when an ancestor is unavailable. Bootstrap wires an Artifacts-owned adapter through an immutable
Orchestration-owned port; Orchestration has no dependency on Artifacts or its schemas.
The public surface exposes the port, accepted-activation and joined-results queries,
and the retryable error, while registration and reconciliation stay internal.
Work owns only validated generic ancestry; assignments and criteria stay in
Orchestration reservations. OrchestrationRepository is the delegation journal
reader. Its fold routes root reservations to the owning parent and records the
fence immediately, including nested parents before wait registration. A single
admission gate protects ordinary outcomes, signals, retries, resource transitions,
dispatch and wait expiry. Reconciliation
faults are recorded once per cohort and stable reason code and retried without stalling
unrelated work, even if recording the diagnostic fails. Unavailable adapters produce isolated durable diagnostics when delegation needs
reconciliation; unrelated workflows keep advancing. Signals, approvals,
resource transitions are durably deferred while fenced and replayed through
normal authority checks when the same stage, intent and resource revision wait
exists. Execution retries reject with a retryable `DelegationPendingError`;
the scheduler retains their durable Runs without blocking the parent.
Only the exact reserving activation's outcome may be held. Join waits for the
reserving Run to end before continuation. New assignments must select a current
configured workflow fingerprint; committed reservations recover the pinned one.
Reservation contention retries are bounded and use fresh root-stream sequences.
Unavailable prerequisites remain retryable. Hard child failures and changed
consumed inputs retain durable blockers while independent siblings finish. A
queued cohort then settles as failed and atomically requests a fresh parent
assessment activation after the reserving Run ends. Affected unfinished child
workflows are superseded. The agent may explicitly submit a replacement batch
under normal authority and limits, with new immutable receipts and fresh outputs.
Live parent attention coalesces the unresolved reasons (recorded child blockers and children
blocked on an agent clarification) into one assessment activation at the delegating stage,
keyed by cohort revision and blocker identities. `delegationAttention` on the parent view
suspends the cohort wait, so attention and the successful join share the parent's single
activation: a join completing meanwhile stays pending in the journal and proceeds when the
assessment ends, and a blocker arriving meanwhile waits for the next one. Each blocker is
raised once; a still-blocked member stays visible and is never polled. A fully terminal
batch keeps the ordinary unsuccessful continuation. The attention outcome never takes
ordinary routing: it only restores the wait. A reply (`respondToDelegationAttention`)
names the child, blocker and assignment revision, is bound to the attention activation's
Run, and resumes only a child blocked for assignment context; terminal failures and
human-only gates are rejected, exact accepted references are granted through the
Artifacts port, and budgets are untouched. A delegating activity that is not an agent
records one operator diagnostic instead of an attention activation. This applies to every
cohort, with or without prerequisites: a failed member is a durable blocker, independent
members keep starting and running, and the cohort settles unsuccessfully only once every
member is terminal. A child parked by its own routing (blocked after exhausted retries, or
waiting on a human route after a failed outcome) is put to the parent as a failure blocker.
The attention activation's outcome never settles or cancels the cohort: every ending restores
the cohort wait, so independent members keep running and their results stay joinable. A
structured blocked or needs-clarification result is a batched human question: it is also
recorded as an accepted outcome, which the existing publication route delivers to a human,
and its text is kept on the resolved fact; a deliberate `FAILED` the parent agent reports is
escalated the same way. A human reply on the parent is routed by the conversation reactor into
the conversation of each child still blocked on an escalated question, where the ordinary reply
path resumes it, so the answer moves the delivery without settling or joining the cohort. A
failed, rejected or infrastructure-blocked assessment run (runner failure, authentication,
ambiguous or invalid result, unverified completion) records the failure and a diagnostic, and
re-raises the same blockers up to three times; the last attempt also leaves one operator
escalation diagnostic. While an assessment is open, a
second cohort is refused (`attention-open`); replacements are submitted once the cohort
settles and the parent is resumed. Bootstrap adds a typed attention section to the
agent prompt for the attention activation. A completed child
without visible outputs gets one subsequent reconciliation command to make them
visible; its first observation survives restart. Settled cohorts release terminal-child capacity; running siblings remain reserved. Continuation preserves the
delegating activation's typed input and identity flags; exact results are read
through the joined-results query rather than added to activity input schemas.

Parent QA and bounded repair (`DeliveryCoordinator`) is agent-led. Wake records and
validates; the agent decides what to assemble, test and repair. Three parent-stream facts
carry it: `delivery-selection-revised` (the complete current selection, revisioned and
compared with `expectedRevision`), `delivery-candidate-recorded` (the exact repository
revision set, its retained-ref or selected-output sources, contributing outputs and shared
criteria) and `delivery-qa-recorded` (a typed pass, fail or blocked verdict over exactly the
candidate's revisions). A selection must cover every required output of every original
assignment with its own qualifying result or a replacement; a manifest that omits one is
rejected (`uncovered-requirement`), so a requirement cannot be waived. A replacement is a new
child whose assignment names `replaces` (cohort and assignment); it must keep every original
criterion, the repository and the outputs, start from the unmerged contribution when the
original is unmerged, target the original integration base, and only replace a terminal
(completed or superseded) child: correcting a running child is unsupported and says so
(`replacement-unsupported`). Selecting a replacement names the output it replaces, compared
with the current selection. An output replaced in the selection makes every selected result
that consumed it (transitively) stale; unrelated results stay effective and earlier facts stay
history. A candidate cannot be recorded while any selected result is stale. Independent
changes in one repository need an assembled commit published under
`refs/wake/delivery/<root>/<candidateId>/`; its commit is resolved through the parent's
repository authority before the candidate is recorded and again before a passing verdict,
so a missing or moved ref cannot pass and a restart reconstructs it from the retained ref.
Refs are retained; nothing deletes them. QA fails closed: a pass needs an available
environment, the candidate's recipe and no findings. Repair reuses the existing
`maxDescendants` root bound and workflow repeat/retry limits; a failing verdict recorded when
the root has no descendant capacity is marked exhausted and inspection returns its
unresolved findings. The delegation policy's optional `completion` (`qa-approved`, the
default, or `merge-required`) feeds `completion`: QA approval finishes the first and never
the second, until all selected changes are provider-observed merged at their exact selected subjects. Configured final QA gates
replace completion with an explicit block across every append path. `delegation.qa`
names a configured read-only agent stage and optional environment/test recipe. Only its
active Run with a durably prepared exact candidate may record QA; coordinating activations
cannot approve themselves, and QA activations cannot revise selection or delegate.
Execution receives the authorized exact repository assignments and contributing references.
Root exhaustion counts every parent's reservation under the root. Configured failure-repeat
bounds also mark exhausted findings. Direct routes without a QA/completion policy are unchanged.

Repository-bound assignments record an existing Repository Resource, requested
source ref, resolved source commit and logical PR base in the reservation.
Replaying a branch request retains its original pin, including across restart.
Execution validates the parent's explicit repository correlations (or the
inherited assignment for a nested child); the configured provider catalogue
never grants repository authority. Non-code assignments remain repository-free.
A root's default scope is bound at its first delegation request (or inspection) by the
Bootstrap authority adapter: when no Repository Resource is correlated to the root, the
repository named by the provider-observed primary Issue (via the existing repository
identity resolver) is found or discovered as a Repository Resource and correlated to the
root as `secondary`/`provider-observed`. A Repository Resource already correlated to the
root is the explicit scope and suppresses this default.
Agent arguments and issue prose never establish authority, and the permitted set is never
a checkout selection.
A child workflow with a branch or read-only stage now requires a repository
assignment (no first-repository fallback); this tightens delivery 01 behaviour.
Direct workflows are unchanged: artifact verification checks the branch only.
Named outputs retain artifact references or exact change provenance. Multiple change
outputs use separate child-owned branch leases, each with a pinned source and logical
base in the assignment repository. Execution records each output's workspace and HEAD;
provider registration and qualification use that output's own provenance. A revision
Run may omit a repeated report, but must still attest the named output's current head.
Qualification checks provider identity, head, branch, base, original child ownership
and that output's review/check requirements (both default true). Required outputs
(default true) qualify independently; optional outputs never waive required ones.
Workflow output declarations cannot be weakened by an assignment. Successful terminal
routing may join open reviewed PRs without a merge or parent issue closure.
Parent integration of a child with multiple selected changes requires an explicit
child/output target; an ambiguous next-target default is rejected.

## Public contracts

`index.ts` is the only public entry. `OrchestrationService` is a compatibility
and composition facade containing no policy.

## Application policy

Use cases own I/O sequencing through repositories and coordination claims.
Domain files do not import journals, clocks, adapters, or execution
infrastructure except through public contracts.

## Configuration

Owns `orchestration`.

## Relations and events

Owns `orchestration.` events and `workflow.` relations.

## Failure and recovery

Accepted outcomes are typed and replayable. Processor failures retain their
Eventing checkpoint; the watch reconciler is an explicit recovery lane.

## Extension rules

Define processors and handlers in Orchestration, but let Bootstrap compose the
runtime and let Eventing own checkpoint and retry mechanics.

## Scenarios

E2E-ORCH-001, E2E-ORCH-RETRY-001, E2E-ORCH-RETRY-003, E2E-ORCH-WAIT-001,
E2E-ORCH-COMMAND-001, E2E-ORCH-CHILD-001, E2E-ORCH-WATCH-RECOVERY-001,
E2E-ORCH-WATCH-CLOSED-WORK-001, E2E-ORCH-LOOP-001.

Queued prerequisites select explicit named outputs through immutable resolved
child identities. The root reservation sequence guards expected plan revisions
and explicit plus implicit join/merge wait cycles. Consumption receipts pin
accepted artifact revisions or provider-verified change heads and source assignments
before child start; a same-repository base selection overrides only that child's
execution assignment. Live eligibility revalidates those receipts for dispatch,
outcomes and joins, including after restart; affected downstream evidence is ineligible without erasing history or choosing
Git repairs. A successful join does not impose a live blanket hold on its parent
while the agent merges the stack. Upstream PR target movement is not movement of
the consumed head; a verified merge preserves already consumed heads after branch
deletion. Admission batches share one journal/Work snapshot and memoize provider
and Git verification within the pass. Reconciliation skips settled cohorts;
prerequisite diagnostics use stable reason-code identities. Cross-repository prerequisites carry accepted context,
never Git ancestry. Independent children remain eligible while others wait.
