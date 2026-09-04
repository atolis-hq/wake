---
asOf: 5031f5b26b684460a94bb1b97599813cc14c5926
---

# Activities ? Module Specification

## Purpose and scope

Activities owns the contract for a named, typed unit of specialist SDLC
capability (an "Activity") that Orchestration invokes as a workflow step, plus
the small set of concrete built-in Activities Wake ships with: an
agent-execution Activity, and pull-request approve/merge Activities together
with the pull-request domain knowledge (observed state, review trust, merge
authority) those built-ins need to decide safely.

## Responsibilities and boundaries

Activities owns:

- The generic Activity contract ? typed input/outcome schemas, declared
  outcome kinds, resource requirements, execution kind ? and the registry
  that validates and executes a named Activity against that contract.
- Specialist SDLC policy for pull requests: observed PR state, review-signal
  trust, and approve/merge authority decisions.
- The `activity-decision` stream identity that makes a `pr.approve`/`pr.merge`
  Activity's decision idempotent per activation.
- `pr.*` and `review.*` event types, recorded on a Resource's or WorkItem's
  own stream (Activities does not own those streams ? see below), plus a
  reserved but currently unused `activities.*` event namespace.

Activities does not own:

- Deciding which Activity to run next, retry/backoff policy, or how a
  reported outcome changes workflow state ? Orchestration's responsibility;
  Activities only reports a typed outcome.
- *How* an Activity runs: process lifecycle, runner pool selection, timeouts,
  concurrency ? Execution's responsibility; Activities receives an
  already-prepared `ActivityExecutionContext`.
- Resource identity, capability registration, or correlation to a WorkItem ?
  Resources' responsibility; Activities only reads a `ResourceView` and its
  correlations, already recorded there.
- WorkItem identity and lifecycle ? Work's responsibility; Activities only
  reads a `WorkItemView` to decide PR authority.
- Actually delivering an approve/merge action to a provider, or reporting its
  result. Activities records the *intent* to deliver as a durable fact and
  reports a `waiting` outcome; something outside this module performs
  delivery and reports the result as a signal Orchestration correlates back.

## Event publishing boundary

Activities owns its event types, payload map, stream references, selector and
decoder, and `createActivityEventData` factory. It creates immutable event data
without stream or journal metadata; its services and handlers append non-empty
batches through `EventJournal.appendToStream` with an expected sequence.
Activities handles its own idempotency and conflicts; it does not construct
envelopes or host processors.

## Ubiquitous language

- **Activity** ? a named, typed unit of specialist capability, registered
  once with an input schema, an outcome schema, a declared closed set of
  outcome kinds, declared resource requirements, and an execution kind.
- **Activation** ? one invocation of an Activity for one workflow step,
  identified by an `ActivationId`.
- **Outcome** ? the closed-vocabulary classification (`waiting` / `done` /
  `rejected` / `blocked` / `failed`) of what an Activity's execution
  produced, always a member of that Activity's own declared set.
- **ResourceRequirement** ? a capability, cardinality, and optional role an
  Activity declares it needs resolved before it runs.
- **PR-shaped resource** ? a Resource whose capabilities include
  `reviewable`, `approvable`, or `mergeable`; a behavioural definition, not a
  Resource kind.
- **Delivery intent** ? a fact recorded to mean "please deliver this
  approve/merge action"; something outside Activities performs it and later
  reports a `delivery-result` signal.
- **Decision claim** ? the durable, idempotent record that a `pr.approve` or
  `pr.merge` activation resolved to a specific outcome, keyed by activation
  and action.
- **Approve/merge authority** ? the deterministic decision of whether a
  WorkItem's correlated pull request may currently be approved or merged.
- **RetrySafety** ? an optional, closed-vocabulary hint (`safe-to-retry` /
  `requires-reconciliation`) an outcome's data may carry; see below.

## Core policies, invariants, and behaviours

- An Activity's input MUST validate against its own declared input schema
  before its handler runs, and its returned outcome MUST validate against
  its own declared outcome schema and be a member of its declared outcome
  kinds, or the result MUST be rejected.
- Every `pr.*`/`review.*` fact recorded on a Resource's stream that carries a
  `resourceId` in its payload MUST identify that same Resource as the stream
  it is recorded on; a mismatch is invalid and MUST NOT decode.
- Every `pr.approve-decision-claimed`/`pr.merge-decision-claimed` fact MUST
  self-identify: its stream id MUST derive from its own activation and
  action, its wrapped fact's own activation id MUST match the claim's, and
  the claim's outcome data MUST match that wrapped fact (a `requested`
  outcome's `intentEventId` equals the fact's event id; a `denied` outcome's
  reason equals the fact's reason).
- Results MUST be accepted idempotently: replaying the same activation for
  the same action MUST return the previously recorded outcome rather than
  recompute a decision or duplicate a fact.
- A `waiting` outcome's data MUST include `intentEventId` and `signalKind`;
  Orchestration correlates a later signal event back to this specific
  outcome by those two fields, not by activation id alone.
- An outcome's data MAY include a `retrySafety` value. Orchestration treats
  `requires-reconciliation` as disqualifying automatic retry regardless of
  the workflow route's own retry policy; Activities defines the vocabulary
  but does not itself act on it.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `pr.discovered` | A PR-shaped Resource is first observed for a WorkItem | Wake now has an initial read of this pull request's state, revisions, and checks. |
| `pr.revision-changed` | A later observation reports a different head/base revision | The pull request has new commits; prior review acceptance and changed-files evidence for the old revision no longer apply. |
| `pr.state-changed` | A later observation reports a different open/closed/merged state | The pull request's lifecycle state has moved. |
| `pr.checks-changed` | A later observation reports a different checks state | Whether the pull request's checks are passing has changed, which can affect authority. |
| `pr.review-accepted` | A trusted human reviewer accepts the current revision | This revision now has a recorded, trusted acceptance authority can rely on. |
| `review.acceptance-signal-recorded` | Any acceptance signal, trusted or not, is observed | An audit record of every acceptance attempt, independent of whether it counted. |
| `pr.review-changes-requested` | A reviewer requests changes on the current revision | Any currently accepted review for this pull request is no longer current. |
| `pr.review-rejected` | An observed review signal cannot be accepted as given (missing/conflicted resource, stale revision, or untrusted actor) | The attempted signal was recorded but did not become an accepted review. |
| `pr.merge-denied` | A merge-authority decision (the gate, or the `pr.merge` Activity) is not allowed | The pull request may not currently be merged, for the recorded reason. |
| `pr.approve-denied` | An approve-authority decision (the `pr.approve` Activity) is not allowed | The pull request may not currently be approved, for the recorded reason. |
| `pr.merge-authorized` | The merge-authority gate decides a WorkItem's correlated pull request may be merged | Merge authority has been durably granted for the current revision. |
| `pr.approve-requested` | The `pr.approve` Activity's authority decision allows the approval | An intent to deliver an approval to the provider now exists; the Activity waits for a delivery result. |
| `pr.merge-requested` | The `pr.merge` Activity's authority decision allows the merge | An intent to deliver a merge to the provider now exists; the Activity waits for a delivery result. |
| `pr.approve-decision-claimed` / `pr.merge-decision-claimed` | A `pr.approve`/`pr.merge` activation resolves to an outcome for the first time | This activation's decision (denied or requested) is now fixed; replaying it returns this outcome. |

## Conceptual schema

**ActivityInvocation** (assembled by Execution per activation, not durable)

| Field | Type | Description |
| --- | --- | --- |
| `activationId` | Activation identity | Identifies one invocation of an Activity for one workflow step. |
| `activity` | Activity name | Which registered Activity this invocation is for. |
| `workItemId` | WorkItem identity | The WorkItem the invocation acts on behalf of. |
| `workflowInstanceId` | Workflow instance identity | The workflow instance driving this invocation. |
| `orchestrationGroupId` | Orchestration group identity | Correlates this invocation to sibling invocations/decisions from the same workflow group. |
| `causationId` | string | The command/event that caused this invocation. |
| `input` | Activity-specific input | Validated against the Activity's own input schema before execution. |
| `resources` | list of ResourceView | The resources Execution resolved for this invocation. |

**ActivityOutcome**

| Field | Type | Description |
| --- | --- | --- |
| `kind` | closed vocabulary: `waiting` / `done` / `rejected` / `blocked` / `failed` | What happened; MUST be a kind the Activity declared. |
| `data` | outcome-specific payload | Present or absent per outcome kind; shape is declared by the Activity's own outcome schema. |

**ResourceRequirement**

| Field | Type | Description |
| --- | --- | --- |
| `capability` | Resource capability | What capability an invocation's resolved resource(s) must provide. |
| `cardinality` | closed vocabulary: `zero-or-one` / `exactly-one` / `one-or-more` | How many resources of that capability the Activity needs. |
| `role` | closed vocabulary: `primary` / `secondary` (optional) | Distinguishes multiple required resources of different significance. |

## Child components and interactions

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [Activity Registry](contracts/registry.spec.md) | surface application | Activity registration, input/outcome validation, dispatch | The entry point Execution calls to run a named Activity; concrete Activities register into it at composition time. |
| [Agent Activity](agent/agent-activity.spec.md) | adapter | Translating a runner's transport result into a declared outcome | Registered into the Registry as the built-in `agent` Activity; Execution supplies the `AgentRunnerPort` via the execution context. |
| [PR Observation](pr/observation.spec.md) | aggregate | Observed PR state and review-signal facts, keyed by the PR's Resource identity | Produces the `PullRequestView` and accepted-signal history that Authority and PR Decision both read. |
| [PR Merge & Review Authority](pr/authority.spec.md) | policy/process | The deterministic approve/merge authority decision, and review-signal trust rules | Reads Observation's facts (plus Work/Resources) to decide allowed/denied; used by the merge-authority gate and by PR Decision. |
| [PR Approve & Merge Decision](pr/decision.spec.md) | aggregate | The `activity-decision` stream: one claimed, idempotent decision per activation and action | Registered into the Registry as the built-in `pr.approve`/`pr.merge` Activities; consults Authority, then records a denial or a delivery-intent fact. |

## Dependencies and system role

- Eventing — the public event-data, envelope, journal, and command-context
  contracts Activities uses to append and decode its own facts.
- Kernel — generic closed-vocabulary and branded-identifier conventions.
- Resources (Activities depends on it) ? Activities reads `ResourceView` and
  correlation facts to resolve which Resource a PR command or Activity
  concerns; it never writes a resource-identity fact, only its own
  `pr.*`/`review.*` facts onto a Resource's stream.
- Work (Activities depends on it) ? Activities reads a WorkItem's identity
  and view to decide PR authority; it never writes `work.*` facts.
- Execution (depends on Activities) ? resolves and executes a named
  Activity's invocation, supplying the `ActivityExecutionContext` (signal,
  clock, runner port, reporting callbacks) and reading back the validated
  outcome.
- Orchestration (depends on Activities) ? compiles workflow steps against the
  registry's declared Activities and outcome kinds, and decides the next
  workflow transition from a reported outcome; Activities never decides that
  transition itself.
- Integrations (depends on Activities) ? the GitHub inbound translator calls
  `observe`/`acceptReviewSignal`/`requestChangesSignal` to turn provider
  events into PR facts; a review-command translator builds the
  `ProposedReviewSignal` value this module's contract describes.

## Decisions, exclusions, and deferred capability

- The `activities.` event namespace is reserved in `module.json` but no
  event currently uses it; every emitted event today is `pr.*` or `review.*`.
- The `activity.` relation namespace is reserved in `module.json` but
  Activities does not currently define any relation kind.
- The merge-authority gate (and the `authorizeMerge`/`decideAuthority`
  methods it wraps) is implemented and exported but not currently invoked
  from production composition; it is not yet a reachable workflow step. See
  the Authority component page.
- `activitiesConfigSchema` is an empty, strict object: the module currently
  exposes no operator-configurable settings of its own.
- None of the built-in Activities (`agent`, `pr.approve`, `pr.merge`)
  currently declare a `ResourceRequirement`; each resolves its own target
  Resource internally from whatever `invocation.resources` Execution
  supplies, reporting a `blocked` outcome (not a hard validation failure) when
  resolution fails.
- Review-signal proposal (`proposeReviewSignal`) is a pass-through today; it
  validates nothing beyond its input's shape.

## Task 27B synchronization (2026-08-02)

Agent outcomes may carry structurally validated `reportedArtifacts`; malformed claims are discarded without changing the outcome. GitHub-native formal reviews are admitted only through the provider?s formal-review evidence path. PR comments, including command-looking text, remain feedback and never become Activity control signals.

## Task 27 synchronization (2026-08-10)

Execution supplies an optional durable `runId` in an Activity execution
context. The Agent Activity uses that identity as the runner request's run
identity when present, preserving the activation identity only for callers
outside an Execution run.
