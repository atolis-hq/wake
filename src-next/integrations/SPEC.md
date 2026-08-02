---
asOf: 312633a1f45b9182803dbfbce74b650069608da6
---

# Integrations — Module Specification

## Purpose and scope

Integrations is Wake's boundary to the outside world. It owns every
provider-specific adapter, the provider-neutral contracts those adapters
translate through, and the durable delivery of outbound facts back to a
provider. It is where a ticketing/PR provider's own vocabulary (labels, issue
numbers, review states) becomes the commands Work, Resources, and Activities
accept, and where those modules' own outbound facts (status updates, replies,
PR approve/merge) become a specific provider's API calls.

## Responsibilities and boundaries

Integrations owns:

- Provider adapter composition — registering a `ProviderDefinition` and
  composing operator configuration into running `ProviderInstance`s.
- `work-admission` — the single process by which a newly observed, eligible
  external object becomes Wake work: discovering its Resource, creating its
  WorkItem, correlating the two, and starting the WorkItem's workflow.
- Provider-neutral intake vocabulary — facets, rules, and match modes a
  provider's own translator maps its vocabulary onto to decide eligibility
  and tags.
- Durable outbound delivery — turning a delivery intent (PR approve/merge,
  status publish, reply publish) into a confirmed/failed/ambiguous external
  effect, with crash-safe idempotent retry via reconciliation.
- The concrete GitHub provider — polling issues and pull requests into
  evidence, translating that evidence into Work/Resources/Activities
  commands, and translating outbound delivery intents into GitHub API calls.

Integrations does not own:

- Canonical Work, Resource, or Activity state. It mints identities and issues
  commands against them; Work, Resources, and Activities own acceptance,
  invariants, and the resulting facts.
- Workflow policy. Which workflow an admitted observation starts is decided
  by a caller-supplied `WorkflowRouter`; Integrations never proposes a
  workflow name itself, only asks Orchestration to start the one selected.
- PR-shaped domain policy — review trust, and approve/merge authority.
  Activities' PR Observation and Authority own that; Integrations' GitHub
  inbound translator only calls its `observe`/`acceptReviewSignal`/
  `requestChangesSignal` commands and does not re-implement their rules.

## Ubiquitous language

- **AdapterId** — the operator-assigned name of one configured provider
  instance (e.g. `github`), matching `^[a-z][a-z0-9-]*$`; distinct from the
  provider type it is composed from — a config entry may set `provider`
  explicitly to run one provider type under a different adapter name.
- **ProviderInstance** — one composed adapter: an `ExternalEventSource` to
  poll, an `ExternalDeliveryAdapter` to deliver through, an
  `InboundTranslation` to turn evidence into commands, and the closed set of
  event types it may emit.
- **Evidence** — a provider's report of external state, recorded to that
  adapter's own `integration` stream; not yet a Wake command.
- **IntakeFacts / IntakeRule / IntakeDecision** — provider-neutral
  eligibility vocabulary. Facts are a named set of observed string values per
  facet (e.g. `label`); a rule states required facet values and a match
  mode; a decision is admitted-or-not plus the union of tags every matched
  rule contributes.
- **work-admission** — the process that, for one eligible observation with
  an already-minted Resource/WorkItem identity pair, discovers the Resource,
  creates the WorkItem, correlates them as `primary`, and starts the
  WorkItem's workflow.
- **DeliveryIntent** — a durable fact requesting one external effect (PR
  approve, PR merge, status publish, reply publish), identified by the
  event id of the fact that requested it.
- **Delivery attempt / occurrence** — one cycle of the delivery loop against
  a single intent; occurrences are ordered by `occurrenceOrdinal`, and each
  records at most one `delivery.*` outcome fact.
- **Reconciliation** — re-querying the provider for an intent's
  already-attempted effect, instead of re-attempting it, when a prior
  attempt's outcome is unknown (ambiguous, or interrupted before a terminal
  fact was recorded).

## Core policies, invariants, and behaviours

- Polled evidence MUST be appended to a provider's own `integration` stream
  only for event ids not already present on that stream; the same evidence
  never records twice no matter how many times a provider re-reports it.
- With no intake rules configured, every observation MUST be admitted with
  no tags. With rules configured, an observation MUST be admitted only if at
  least one rule matches, and MUST collect the union of every matched rule's
  tags.
- A rule matches when, independently for every facet named in its `where`,
  the facet's required values are satisfied against the observation's own
  values for that facet under the rule's match mode: `all` requires every
  required value present, `any` requires at least one; a facet with no
  required values is trivially satisfied.
- `work-admission` MUST be the only place a newly observed external object
  becomes Wake work: discover the Resource, create the WorkItem, correlate
  them as `primary`, then start the WorkItem's workflow via the
  caller-supplied router. No adapter proposes a workflow name itself.
- A caller MAY supply evidence that must exist before a WorkItem's workflow
  starts (e.g. an initial PR observation). `work-admission` MUST record it
  after correlation and before starting orchestration, so the workflow's
  entry stage sees it from its first tick.
- Each delivery intent owns its own `delivery` stream, keyed by the intent's
  own event id; delivery facts for one intent MUST NOT be recorded against
  another intent's stream.
- A delivery attempt MUST resolve, per occurrence, to exactly one of
  confirmed, failed, or ambiguous. Ambiguous and interrupted (attempted but
  not yet resolved) intents remain eligible for a further delivery cycle;
  failed and confirmed intents do not.
- Before attempting delivery again for an intent that is already ambiguous,
  or that has at least one prior attempt, the delivery loop MUST reconcile
  with the provider first rather than re-attempt the external effect; only a
  "not found" reconciliation result permits a fresh attempt.
- A confirmed, or terminally-reconciled-confirmed, delivery MUST report a
  `done` outcome, and a failed delivery MUST report a `failed` outcome, to
  the workflow instance and activation the originating intent named.
  Ambiguous or unresolved reconciliation MUST NOT report an outcome.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `integration.<adapter>.*` | A provider adapter polls and reports new or changed external state | Provider evidence now exists on that adapter's own stream, independent of whether it becomes a Wake command. |
| `status.publish-requested` | A workflow step requests a status update be delivered to a Resource's provider | A durable delivery intent now exists for a status comment. |
| `reply.publish-requested` | A workflow step requests a reply be delivered to a Resource's provider | A durable delivery intent now exists for a reply comment. |
| `delivery.attempt-started` | The delivery loop begins one attempt against an intent | An external effect is about to be attempted; a later retry without a terminal fact after this one means the attempt's result is unknown. |
| `delivery.confirmed` | The provider confirms the intent's effect occurred | The intent is durably done; no further delivery attempt is made. |
| `delivery.failed` | The provider rejects or errors the intent's effect | The intent is durably failed; no further automatic delivery attempt is made. |
| `delivery.ambiguous` | An attempt's result could not be determined | The intent stays eligible for a further cycle, which reconciles before attempting again. |
| `delivery.reconciled` | A reconciliation query against the provider resolves, or fails to resolve, an ambiguous or interrupted attempt | Either the intent is now known confirmed, or its uncertainty persists (not found / unknown). |

## Conceptual schema

**IntakeRule**

| Field | Type | Description |
| --- | --- | --- |
| `where` | map of facet name to list of required string values | What an observation must show, per facet, to match this rule. |
| `matchMode` | closed vocabulary: `any` / `all` | How a facet's required values are compared to the observation's own values for that facet. |
| `tags` | list of string | Tags this rule contributes to the observation when it matches. |

**IntakeDecision**

| Field | Type | Description |
| --- | --- | --- |
| `admitted` | boolean | Whether the observation is eligible to become or update Wake work. |
| `tags` | list of string | Union of every matched rule's tags; empty when no rules are configured or none matched. |

**DeliveryIntentView**

| Field | Type | Description |
| --- | --- | --- |
| `intentEventId` | Event identity | The requesting fact's own event id; also this intent's identity and its `delivery` stream key. |
| `globalPosition` | integer | The requesting fact's position in the journal. |
| `workflowInstanceId` | Workflow instance identity | Where the delivery outcome is reported back to. |
| `activationId` | Activation identity | Which activation's outcome the delivery result corresponds to. |
| `kind` | closed vocabulary: `pr.approve` / `pr.merge` / `status.publish` / `reply.publish` | What kind of external effect this intent requests. |
| `resourceId` | Resource identity | Which Resource, and therefore which adapter, delivers this intent. |
| `payload` | kind-specific payload | The effect's own data (revision/body/merge method, as applicable to its kind). |
| `state` | closed vocabulary: `pending` / `confirmed` / `failed` / `ambiguous` | Current delivery state, folded from this intent's own `delivery.*` facts. |
| `attempts` | integer | Count of `delivery.attempt-started` facts recorded for this intent. |
| `occurrenceOrdinal` | integer | The highest occurrence ordinal recorded for this intent so far. |
| `reconciliationKey` | string (optional) | Set when ambiguous; what the provider's `reconcile` call should look up. |

## Child components and interactions

**General**

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [Work Admission](application/work-admission.spec.md) | policy/process | The discover → create → correlate → start sequence for one eligible observation | The single path by which any provider's inbound translation turns an eligible observation into Work, Resources, and an orchestration start. |
| [Provider Composition & Inbound Polling](application/provider-composition.spec.md) | adapter | Provider registration/composition from config, and idempotent evidence ingestion onto the `integration` stream | Instantiates each configured `ProviderInstance` (GitHub, fake) and is the entry every provider's own poll loop appends evidence through. |

**Delivery**

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [Delivery](delivery/delivery.spec.md) | aggregate | The per-intent `delivery` stream: attempt/outcome facts, reconcile-before-retry | Attempts the next pending/ambiguous intent the projection surfaces, through whichever provider's `ExternalDeliveryAdapter` owns that intent's Resource. |
| [Delivery Intent Projection](delivery/delivery-projection.spec.md) | projection | `DeliveryIntentView`, folded from intent-request facts plus this module's own `delivery.*` facts | Supplies the Delivery aggregate its pending/ambiguous work queue; rebuilds purely from the same facts the aggregate and Activities record. |
| [Delivery Outcome Reactor](delivery/delivery-outcome-reactor.spec.md) | policy/process | Correlating a resolved `delivery.*` fact back to an Orchestration outcome | Reads the Delivery aggregate's own facts once each and reports `done`/`failed` to the workflow instance/activation the intent named. |

**GitHub**

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [GitHub Inbound Evidence](github/inbound-evidence.spec.md) | adapter | Polling GitHub issues/PRs into `integration.github.work-observed` evidence | Feeds Provider Composition's generic ingestion; produces the evidence GitHub Inbound Translation consumes. |
| [GitHub Inbound Translation](github/inbound-translation.spec.md) | adapter | Turning GitHub evidence into Work/Resources/Activities commands | Consumes evidence from GitHub Inbound Evidence; calls Work Admission for new objects and Activities' PR Observation for pull-request state. |
| [GitHub Outbound Delivery](github/outbound-delivery.spec.md) | adapter | Translating a `DeliveryIntentView` into a GitHub API mutation | The `ExternalDeliveryAdapter` the Delivery aggregate calls for any intent whose Resource is a GitHub resource. |

## Dependencies and system role

- Kernel — event journal, checkpoint store, envelope/stream conventions, and
  closed-vocabulary helpers every component in this module builds on.
- Work (Integrations depends on it) — `work-admission` creates WorkItems and
  reads correlation state; Integrations never writes `work.*` facts.
- Resources (Integrations depends on it) — `work-admission` and GitHub
  Inbound Translation discover/correlate Resources and read `ResourceView`;
  Integrations never writes resource-identity facts.
- Activities (Integrations depends on it) — GitHub Inbound Translation calls
  PR Observation's `observe`/`acceptReviewSignal`/`requestChangesSignal`
  commands; the Delivery Intent Projection reads the `pr.approve-requested`/
  `pr.merge-requested` facts Activities' PR Approve & Merge Decision
  produces.
- Orchestration (Integrations depends on it) — `work-admission` starts a
  WorkItem's workflow; the Delivery Outcome Reactor reports outcomes back to
  it; a `WorkflowRouter` and `WorkflowCandidate`/`WorkflowName` types are
  Orchestration's own contracts, supplied to this module by its composition
  root.
- Bootstrap (depends on Integrations) — a status/reply-publish Activity
  outside this module records `status.publish-requested`/
  `reply.publish-requested` facts on a Resource's own stream, using this
  module's own event type constants.
- The runtime composition root (outside any module) — instantiates
  `ProviderInstance`s from configuration and drives the poll, inbound
  translation, delivery, and outcome-reactor loops each tick. No domain
  module other than Bootstrap depends on Integrations directly.

## Decisions, exclusions, and deferred capability

- GitHub label reconciliation (`reconcileGitHubWakeLabels`) and self-echo
  detection (`isGitHubWakeEcho`) are implemented and exported but not
  invoked by the composed GitHub inbound or outbound pipeline: the inbound
  translator reads labels only as intake-matching facts, and no outbound
  action writes a label back to GitHub. Reconciling Wake-owned labels
  against a local projection every tick is not current `src-next` GitHub
  behavior; these functions exist as building blocks for that future wiring.
- GitHub PR review-signal evidence (comment/review observation, and the
  `integration.github.comment-observed` event it would produce) is fully
  consumed by GitHub Inbound Translation's `/accepted`/`/changes`
  review-command handling, but the composed GitHub source does not
  currently poll comments or reviews to produce that evidence. Until a
  poller is wired, GitHub review acceptance signals cannot reach Activities
  through polling.
- The fake provider's evidence events (`fake.work-observed`,
  `fake.review-requested`) intentionally use a `fake.` prefix rather than
  the `integration.<adapter>.` convention real providers use; they are a
  test-harness fixture, not modeled provider evidence, and are not part of
  this module's own event namespace.
- `fake/*` is a permanent test-harness adapter family that satisfies the
  same `ProviderDefinition` contract as `github`. It is not specified as its
  own component here because its behaviour is the same contract, exercised
  with deterministic fixtures instead of network calls.
- `github.publication.postStatusComments` is accepted by configuration but
  not read by any current delivery or translation path; status delivery is
  not currently gated by it.

## Task 27B synchronization (2026-08-02)

Artifact claims are provider-verified before discovery/correlation. Transient verification uncertainty is checkpoint-independent, bounded, and escalated durably; confirmed negatives are failed. Delivery unknown reconciliation is likewise bounded and marks an intent escalated, after which only an operator resolution or a confirmed provider result can clear it. GitHub review intake consumes formal review evidence only. Each tick also reconciles Wake-owned GitHub status/stage/workflow labels for correlated resources while preserving user labels; labels are presentation, not commands that mutate arbitrary workflow stages.

