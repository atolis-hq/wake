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
its workflow reached configured terminal completion without a failure outcome and every named output resolves to
an accepted exact artifact revision. Production exposure is deferred to the
delegation controls work. Bootstrap wires an Artifacts-owned adapter through an immutable
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
Blocked children remain recoverable and keep the cohort waiting.
Cancelled, closed or deleted child work before workflow completion settles the
cohort as failed. A completed child without visible outputs gets one subsequent
reconciliation command to make them visible, with the first observation persisted
across restart; missing outputs after that block the parent and settle the cohort. Settled cohorts release terminal-child capacity; running siblings remain reserved. Continuation preserves the
delegating activation's typed input and identity flags; exact results are read
through the joined-results query rather than added to activity input schemas.

Repository-bound assignments record an existing Repository Resource, requested
source ref, resolved source commit and logical PR base in the reservation.
Replaying a branch request retains its original pin, including across restart.
Execution validates the parent's explicit repository correlations (or the
inherited assignment for a nested child); the configured provider catalogue
never grants repository authority. Non-code assignments remain repository-free.
This slice consumes existing Repository Resources and adds no production path
that creates or authorizes one; the composed fixtures create and correlate them
through the public Resources port. Creating and narrowing repository authority
belongs to the policy/capacity story (#962), which must supply the permitted
set without turning it into an implicit checkout selection.
Named outputs retain artifact references or exact change provenance. This slice
supports one change output per child, reported through a named reportedArtifacts
entry; a later revision run need not repeat it, because the provider must
confirm the PR now points at the latest implementation head. Qualification
checks provider identity, head, branch, base, original
child ownership and the output's review/check requirements (both default true).
Successful terminal routing can therefore join an open reviewed PR without a
merge or parent issue closure. General multi-change joins remain deferred.

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
