# Supplemental activity policy — Component Specification

## Type, purpose, and scope

Policy/process. This component owns queueing an out-of-band supplemental
Activity against an Active WorkflowInstance, dequeuing the next queued
activity to run, judging a supplemental activity's own outcome, and
authorising which actor kinds may request a given configured command.

## Responsibilities and boundaries

Supplemental policy owns the supplemental queue's append/dequeue facts and
the actor-kind-to-approval-authority mapping used to authorise a command
request. It does not decide which commands exist or which authorities a
command permits — that is configuration, validated by the workflow compiler.
It does not run the requested Activity; it only records that it is queued,
then later that it is the pending Activation. Once a supplemental
Activation's outcome is judged, control returns either to the next queued
supplemental activity or to the Stage's own interrupted Activity — this
component does not itself decide the Stage's next transition.

## Core policies, invariants, and behaviours

**Queueing**

- A supplemental activity request MUST only be accepted when the instance's
  status is `active` and it has a pending Activation; an instance that is
  `waiting`, `blocked`, or `completed`, or has no pending Activation, MUST be
  rejected ("supplemental commands require an active WorkflowInstance").
- Acceptance appends `SupplementalActivityQueued`, unconditionally adding to
  the end of the FIFO queue; there is no bound on queue depth enforced here.

**Judging a supplemental Activation's outcome**

- Dispatch to this judgment only happens when the pending Activation is
  itself flagged supplemental; the Stage's own configured `OutcomeRoute`,
  retry policy, and follow-on Activities are never consulted for a
  supplemental Activation's outcome.
- A non-`done` outcome MUST block the instance (`InstanceBlocked`, reason
  naming the outcome kind); a failed supplemental activity is never retried
  by this component.
- A `done` outcome with a non-empty remaining queue MUST dequeue and request
  the next queued supplemental activity instead of resuming the Stage.
- A `done` outcome with an empty queue MUST re-request the Stage's own
  configured Activity and input, carrying that Stage's `execution` config —
  control returns to the interrupted Stage activation from scratch, not from
  any partial progress.

**Dequeuing**

- Dequeuing the head of the queue appends `SupplementalActivityDequeued`
  (naming the activity and its original requester) followed by
  `ActivityRequested` for that queued activity and input.
- A dequeued supplemental Activation's `execution` config is always absent —
  unlike a Stage's own activation, a retry, or a follow-on, a supplemental
  activity never carries the Stage's workspace/runner-pool configuration
  through.

**Authorising a request**

- A command's `allowedActors` (configured per supplemental command) declares
  who may *invoke* it — approval authority — which is distinct from the
  provenance of the actor that emitted the event requesting it.
- Only the event actor kinds `operator` and `integration` currently resolve
  to any approval authority, and both resolve to `human`; no other actor
  kind resolves to an authority at all, so no actor kind can currently
  satisfy a command configured to allow only `auto` or `watch`.
- `auto` is never inferred from an actor's kind or transport, regardless of
  configuration — it would otherwise grant automatic-approval authority
  without the operator consent that `auto` is defined to require elsewhere
  in the module.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `orchestration.supplemental-activity-queued` | An authorised request is accepted against an Active instance | The named Activity is now queued to run before the Stage's own pending activity resumes. |
| `orchestration.supplemental-activity-dequeued` | A queued activity becomes the pending Activation | This queue entry is no longer pending. |
| `orchestration.activity-requested` | Immediately following a dequeue, or after the queue drains on a `done` outcome | The named Activity (queued or the Stage's own) is now the pending Activation. |
| `orchestration.instance-blocked` | A supplemental activity's outcome is not `done` | The instance cannot proceed automatically. |

## Conceptual schema

**Queued supplemental activity** — see the WorkflowInstance component's
`supplementalQueue` field for its persisted form.

| Field | Type | Description |
| --- | --- | --- |
| `activity` | Activity name | The Activity to run, from the configured command. |
| `input` | unknown | The command's configured input, validated at compile time. |
| `requestedBy` | string | The actor identity that requested this command. |

## Dependencies and system role

- Activation and transition policy (depends on this component) — dispatches
  to it outright whenever the pending Activation is flagged supplemental,
  and again when a `done` outcome finds a non-empty queue.
- Kernel — `EventActorKind`, the provenance vocabulary this component maps
  to approval authority; distinct from the `ApprovalAuthorityKind` vocabulary
  it maps into.
- Workflow compiler — supplies each command's `allowedActors` list and its
  Activity/input, validated and frozen at compile time.

## Decisions, exclusions, and deferred capability

- The queue is strict FIFO; there is no priority, reordering, or
  cancellation of a queued supplemental activity once requested.
- A failed supplemental activity always blocks the instance; there is no
  retry path for a supplemental Activation, unlike a Stage's own outcome.
- No actor kind currently maps to `auto` or `watch` approval authority for
  command authorisation, so a command configured with only those in
  `allowedActors` cannot currently be invoked through this path.
