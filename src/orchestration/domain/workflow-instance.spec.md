# WorkflowInstance — Component Specification

## Type, purpose, and scope

Aggregate. WorkflowInstance is the stream-owning aggregate for a single
running instantiation of a compiled WorkflowDefinition against one WorkItem.
It owns the workflow-instance stream's identity, folds every
`orchestration.*` fact recorded on that stream into a current view, and is
the sole record of an instance's Stage, status, pending Activation, wait
state, and coordination history. It does not itself decide what to append
next — the activation, retry, signal, supplemental, and child workflow
policies read its current view and return the facts for it to fold.

## Responsibilities and boundaries

WorkflowInstance owns the stream identity, the acceptance of a start
(subject to primary/child provenance and, for a primary, a successful claim
from OrchestrationGroup), and the pure fold from `orchestration.*` facts to
the current `WorkflowInstanceView`. It does not own deciding whether an
outcome retries, a Signal is accepted, a supplemental command is authorised,
or a child request is granted a budget slot — those are the policy
components' responsibility, expressed purely as event drafts this aggregate
then folds.

## Core policies, invariants, and behaviours

**Identity and creation**

- A WorkflowInstance MUST NOT exist before an `InstanceStarted` fact is
  recorded on its stream; the fold returns no view until that fact is found.
- Starting an identity that already has a view MUST be accepted as a no-op:
  the current view is returned and no new fact is recorded.
- A primary start (no parent provenance) MUST only be accepted when the
  named WorkItem exists and is open, and MUST first obtain the WorkItem's
  primary claim from OrchestrationGroup; a start that cannot claim it MUST
  be rejected.
- A child start MUST carry complete provenance — parent WorkflowInstance,
  Watch, trigger, causal cycle, and request identity — or none at all; a
  partially provided set of these fields MUST be rejected.
- A child's own identity MUST equal its request identity, and its declared
  `workItemId` and `orchestrationGroupId` MUST equal its parent's; a child
  start that disagrees with its parent on either MUST be rejected.
- A child start MUST NOT be accepted before its parent WorkflowInstance
  exists.
- Starting an instance appends, in order: for a child, `ChildRequested` then
  `ChildStarted` on the child's own stream first; then always
  `InstanceStarted`, `StageEntered` (for the WorkflowDefinition's entry
  Stage), and `ActivityRequested` (for that Stage's configured Activity).

**Lifecycle status**

- Status starts `active` on `InstanceStarted` and changes only as later
  facts are folded; it is never assigned directly by a caller.
- `ActivityRequested` MUST set status to `active` and clear any current wait
  expectation, whether the instance was previously `active`, `waiting`, or
  `blocked`.
- `ActivityWaiting` and `SignalWaitStarted` MUST set status to `waiting` and
  record a wait expectation; `SignalAccepted` MUST return status to `active`
  and clear it.
- `InstanceCompleted` MUST set status to `completed` and clear both the
  pending Activation and any wait expectation; once `completed`, the
  instance is terminal for this fold (no further status change is defined
  for a completed instance).
- `InstanceBlocked` MUST set status to `blocked`. A caller MAY explicitly
  block an instance directly (independent of any policy decision); doing so
  when the instance is already `blocked` MUST be a no-op that appends no
  new fact.
- `InstanceBlocked` MUST record its reason as `blockReason` for operator
  read models. `OperatorRetryRequested` records the originating command's
  identity in `operatorRetryCommandIds`; this list only grows as facts fold.
- Marking an Activation as started (`ActivityStarted`) MUST only update the
  pending Activation when the given ActivationId matches the instance's
  current pending Activation; otherwise it MUST be a no-op.

**Coordination facts**

- `ChildCompleted`, applied on a child's own stream, MUST be idempotent by
  presence: it is recorded at most once per child, guarded by whether the
  child's own view already reflects it.
- `ChildCompletionConsumed`, applied on a parent's stream, records that a
  specific child's completion has been accepted; a parent MUST NOT reconsume
  the same child's completion once its identity appears in the accepted set.
- `CausalActivationRejected` records, on the parent's stream, that a given
  trigger identity will not be retried as a child request; the parent's
  rejected-trigger set only ever grows.

## Conceptual schema

WorkflowInstance state is the fold of its own `orchestration.*` facts on the
workflow-instance stream identified by `workflowInstanceId`.

| Field | Type | Description |
| --- | --- | --- |
| `workflowInstanceId` | WorkflowInstance identity | The stream's identity; set once by `InstanceStarted`. |
| `workItemId` | WorkItem identity | The WorkItem this instance runs for; set once, never revised. |
| `workflowName` | WorkflowDefinition name | The compiled WorkflowDefinition this instance runs; set once. |
| `orchestrationGroupId` | Orchestration group identity | Shared with the primary and every descendant child; set once. |
| `parentWorkflowInstanceId` | optional WorkflowInstance identity | Present only for a child; identifies its parent. |
| `watchId` / `triggerId` / `causalCycleId` / `requestId` | optional strings | Present only for a child; its full provenance back to the Watch match that started it. |
| `status` | closed vocabulary: `active` / `waiting` / `completed` / `blocked` / `superseded` | The instance's current run state; see lifecycle rules above. |
| `blockReason` | optional string | The reason carried by the most recent `InstanceBlocked` fact. |
| `currentStage` | Stage name | The Stage the instance is currently in; changes only on `StageEntered`. |
| `pendingActivation` | optional Activation (below) | The one outstanding Activation, if any. |
| `repeatCounts` | map of route identity to count | How many times each cycle-closing OutcomeRoute has been taken. |
| `retryCounts` | map of `<stage>:<outcomeKind>` to count | How many times the current Stage has been retried for a given outcome kind. |
| `waitingFor` | optional Signal expectation | Set while `waiting`; cleared on resume. |
| `supplementalQueue` | list of queued supplemental activity | FIFO of commands requested against this instance, not yet run. |
| `acceptedSignalIds` | list of provider event identities | Every Signal this instance has accepted, by provider event identity; guards against re-accepting the same Signal. |
| `operatorRetryCommandIds` | list of command identities | Every operator retry command requested against this instance. |
| `acceptedOutcomes` | list of ActivationId | Every non-waiting outcome this instance has accepted. |
| `acceptedChildCompletionIds` | list of WorkflowInstance identity | Children whose completion this instance has already consumed. |
| `causalRejectionIds` | list of trigger identities | Trigger identities this instance has rejected as causal repeats. |
| `childCompletionRecorded` | boolean | Whether this instance (as a child) has recorded its own `ChildCompleted` fact. |
| `lastOutcome` | optional Outcome | The most recent outcome accepted or recorded as waiting, for read purposes only. |

**Activation** (child entity)

| Field | Type | Description |
| --- | --- | --- |
| `activationId` | Activation identity | Deterministic from the instance identity and ordinal. |
| `ordinal` | positive integer | This Activation's position among all Activations this instance has ever had. |
| `activity` | Activity name | The Activity requested. |
| `input` | unknown, Activity-defined | The validated input passed to the Activity. |
| `execution` | optional execution config | Workspace mode / runner pool hint, carried through from the Stage's configuration. |
| `status` | closed vocabulary: `pending` / `running` / `waiting` / `completed` | This Activation's own progress, independent of the instance's overall status. |
| `followOnIndex` | optional non-negative integer | Present when this Activation is a configured follow-on Activity rather than the Stage's own. |
| `supplemental` | optional `true` | Present when this Activation is a supplemental command's Activity rather than the Stage's own. |

## Dependencies and system role

- Kernel — event/stream conventions for reading and appending its own
  single-identity stream; WorkflowInstance's only dependency for stream IO.
- OrchestrationGroup (depended on by a primary start) — supplies the primary
  claim a primary WorkflowInstance requires before it may be created.
- Activation, retry, signal, supplemental, and child workflow policies
  (depend on this aggregate) — each loads the current view before deciding,
  and its decision is folded back through this aggregate.
- Orchestration projection and Orchestration repository (depend on this
  aggregate's fold) — both derive `WorkflowInstanceView` by applying the
  same fold to `orchestration.*` facts, one as a checkpointed materialised
  view, the other by rereading the stream directly before each command.
- Integrations and board/API surfaces outside this module (depend on this
  aggregate's exported `orchestrationStatusTransitions` table) — derive an
  externally-visible status (e.g. a GitHub label, a board column) from the
  same event-type-to-status mapping the fold itself uses, rather than
  hand-matching `orchestration.*` event types independently.

## Decisions, exclusions, and deferred capability

- A WorkflowInstance has exactly one current Stage and one pending
  Activation at a time; there is no parallel-position or multi-Activation
  model.
- `superseded` is a defined status with a folding rule, but no current
  decision path produces `InstanceSuperseded`; see the module specification.
- There is no snapshot of WorkflowInstance state; every read folds from the
  full fact list for that stream.
