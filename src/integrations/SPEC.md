---
asOf: dbbcd8aa
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
- `work-conclusion` — the single, adapter-neutral process by which an
  already-admitted WorkItem is concluded because its correlated external
  object reached a terminal state outside Wake.
- Provider-neutral intake vocabulary — facets, rules, and match modes a
  provider's own translator maps its vocabulary onto to decide eligibility
  and tags.
- Durable outbound delivery — turning a delivery intent (PR approve/merge,
  status publish, reply publish, agent-run publish) into a
  confirmed/failed/ambiguous external effect, with crash-safe idempotent
  retry via reconciliation. A delivery intent addresses one Resource and
  therefore exactly one owning provider; Integrations deliberately does not
  reproduce legacy generic multi-sink fanout.
- Terminal agent-run publication — projecting a finished Agent-activity
  run into exactly one durable outbound intent per run, addressed to its
  workflow's primary Resource, so an agent's own outcome reaches its
  provider through the same delivery pipeline as every other outbound fact.
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

## Event publishing boundary

Integrations owns its observation, artifact, delivery, and provider event
types, payload maps, stream references, selectors/decoders, and event-data
factories. It appends immutable event data to the selected stream with expected
sequence; it does not construct envelopes or a processor host. Its
delivery outcome reactor keeps ProjectionStore-backed recovery state for pending
confirmations. It is not a rebuildable Eventing projection: recovery decodes
legacy flat and interim nested stored records, then writes the reactor-owned
canonical pending-confirmations record. Its processor delivery and explicit
reconciliation share one injected serialiser, so only one may change that state
at a time.

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
- **work-conclusion** — the process that closes or cancels an already-Open
  WorkItem once a caller reports its correlated external object reached a
  terminal state, idempotent against a WorkItem already concluded.
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

- The polling persistence boundary filters event ids already present on a
  provider's own `integration` stream before appending. Repeated evidence
  therefore does not record twice or retrigger translation after restart; the
  source-local observation cache is only a performance optimization.
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
- `work-conclusion` MUST be a no-op for a WorkItem that cannot be found or
  is not currently Open, so a duplicate observation, a replayed event, or
  Wake's own conclusion echoing back through a later poll is always safe to
  call again.
- Each delivery intent owns its own `delivery` stream, keyed by the intent's
  own event id; delivery facts for one intent MUST NOT be recorded against
  another intent's stream.
- Actionable delivery intents MUST be processed in requesting journal order,
  one intent at a time. A terminal failure for one Resource/provider MUST NOT
  prevent a later intent for another Resource/provider from being processed.
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
| `integration.github.deleted-work-observation-skipped` | GitHub observes a Resource whose historical primary WorkItem was deleted | The observation was durably consumed without reviving the WorkItem or revising its tombstoned Resource. |
| `status.publish-requested` | A workflow step requests a status update be delivered to a Resource's provider | A durable delivery intent now exists for a status comment. |
| `reply.publish-requested` | A workflow step requests a reply be delivered to a Resource's provider | A durable delivery intent now exists for a reply comment. |
| `agent-run.publish-requested` | Agent Run Publication projects a terminal Agent-activity run | A durable delivery intent now exists for that run's own outbound report. |
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
| `kind` | closed vocabulary: `pr.approve` / `pr.merge` / `status.publish` / `reply.publish` / `agent-run.publish` | What kind of external effect this intent requests. |
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
| [Work Conclusion](application/work-conclusion.spec.md) | policy/process | The idempotent close-or-cancel sequence for an already-admitted WorkItem | The single path by which any provider's inbound translation reports an observed terminal outcome as a concluded WorkItem. |
| [Provider Composition & Inbound Polling](application/provider-composition.spec.md) | adapter | Provider registration/composition from config, and idempotent evidence ingestion onto the `integration` stream | Instantiates each configured `ProviderInstance` (GitHub, fake) and is the entry every provider's own poll loop appends evidence through. |
| [Agent Run Publication](application/agent-run-publication.spec.md) | policy/process | Projecting each terminal Agent-activity run into one `agent-run.publish-requested` delivery intent | Reads Execution's terminal run facts and Orchestration's workflow state, and records the intent the Delivery Intent Projection and Delivery aggregate then carry to a provider. |

**Delivery**

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [Delivery](delivery/delivery.spec.md) | aggregate | The per-intent `delivery` stream: attempt/outcome facts, reconcile-before-retry | Attempts the next pending/ambiguous intent the projection surfaces, through whichever provider's `ExternalDeliveryAdapter` owns that intent's Resource. |
| [Delivery Intent Projection](delivery/delivery-projection.spec.md) | projection | `DeliveryIntentView`, folded from intent-request facts plus this module's own `delivery.*` facts | Supplies the Delivery aggregate its pending/ambiguous work queue; rebuilds purely from the same facts the aggregate and Activities record. |
| [Delivery Outcome Reactor](delivery/delivery-outcome-reactor.spec.md) | policy/process | Correlating a resolved `delivery.*` fact back to an Orchestration outcome | Reads the Delivery aggregate's own facts once each and reports `done`/`failed` to the workflow instance/activation the intent named. |

**GitHub**

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [GitHub Inbound Evidence](github/inbound-evidence.spec.md) | adapter | Polling GitHub issues/PRs/reviews/comments into `integration.github.work-observed`/`integration.github.comment-observed` evidence | Feeds Provider Composition's generic ingestion; produces the evidence GitHub Inbound Translation consumes. |
| [GitHub Inbound Translation](github/inbound-translation.spec.md) | adapter | Turning GitHub evidence into Work/Resources/Activities/Orchestration commands | Consumes evidence from GitHub Inbound Evidence; calls Work Admission for new objects, Work Conclusion for terminal outcomes, and Activities' PR Observation for pull-request state; signals Orchestration for issue approvals and verified watch-gate verdicts. |
| [GitHub Outbound Delivery](github/outbound-delivery.spec.md) | adapter | Translating a `DeliveryIntentView` into a GitHub API mutation | The `ExternalDeliveryAdapter` the Delivery aggregate calls for any intent whose Resource is a GitHub resource. |
| [GitHub Label Reconciliation](github/wake-labels.spec.md) | adapter | Reconciling Wake-owned status/stage/workflow labels on correlated GitHub resources | Runs as the GitHub provider's own `maintenance` cycle, reading Orchestration/Resources/Work state; independent of the delivery-intent pipeline. |
| [GitHub Agent Context](github/agent-context.spec.md) | adapter | Folding recorded GitHub evidence into a WorkItem's current content and comment history | Implements Activities' `AgentContextReader` for GitHub, composed directly by Bootstrap to build an agent run's prompt context. |

## Dependencies and system role

- Kernel — event journal, checkpoint store, envelope/stream conventions, and
  closed-vocabulary helpers every component in this module builds on.
- Work (Integrations depends on it) — `work-admission` creates WorkItems,
  `work-conclusion` closes/cancels them, and both read correlation/current
  state; Integrations never writes `work.*` facts directly.
- Resources (Integrations depends on it) — `work-admission`, GitHub Inbound
  Translation, and GitHub Agent Context discover/correlate Resources and
  read `ResourceView`; GitHub's `resolveGitHubResourceUrl` implements
  Resources' own `ResourceLinkResolver` contract, composed directly by
  Bootstrap rather than through `ProviderInstance`; Integrations never
  writes resource-identity facts.
- Activities (Integrations depends on it) — GitHub Inbound Translation calls
  PR Observation's `observe`/`acceptReviewSignal`/`requestChangesSignal`
  commands; the Delivery Intent Projection reads the `pr.approve-requested`/
  `pr.merge-requested` facts Activities' PR Approve & Merge Decision
  produces; GitHub Agent Context implements Activities' `AgentContextReader`
  contract.
- Orchestration (Integrations depends on it) — `work-admission` starts a
  WorkItem's workflow; the Delivery Outcome Reactor reports outcomes back to
  it; GitHub Inbound Translation signals it for issue approvals and verified
  watch-gate verdicts; Agent Run Publication and GitHub Label Reconciliation
  read its workflow-instance state; a `WorkflowRouter` and
  `WorkflowCandidate`/`WorkflowName` types are Orchestration's own contracts,
  supplied to this module by its composition root, as is `WorkConclusion`'s
  real cascade.
- Execution (Integrations depends on it) — Agent Run Publication reads
  `RunRepository` to project a terminal Agent-activity run's own report;
  GitHub Inbound Translation reads it to verify a watch-gate verdict
  marker's claimed run before trusting it.
- Bootstrap (depends on Integrations) — a status/reply-publish Activity
  outside this module records `status.publish-requested`/
  `reply.publish-requested` facts on a Resource's own stream, using this
  module's own event type constants; Bootstrap composes GitHub Agent
  Context and `resolveGitHubResourceUrl` directly, and supplies the real
  `WorkConclusion` cascade from control-plane's own conclusion policy.
- Bootstrap (depends on Integrations) instantiates `ProviderInstance`s from
  configuration, tolerating a construction failure per provider, and registers
  each provider processor in the shared Eventing runtime. Processors handle
  inbound translation and publication (including delivery-outcome reaction);
  the intake pipeline polls providers and admits their observations; and the
  runner pipeline schedules work and performs maintenance and delivery. These
  remain explicit bounded lanes. No domain module other than Bootstrap depends
  on Integrations directly.

## Decisions, exclusions, and deferred capability

- GitHub Label Reconciliation is invoked every tick, as the GitHub
  provider's own `maintenance` cycle, independently of the inbound/outbound
  delivery pipeline; it writes Wake-owned status/stage/workflow labels back
  to each open WorkItem's correlated GitHub resources. Self-echo detection
  (`isGitHubWakeEcho`) remains implemented and exported but is not invoked
  by any composed path.
- GitHub PR review evidence (formal reviews) and issue/PR comment evidence
  are both polled and produce `integration.github.comment-observed`
  evidence, consumed by GitHub Inbound Translation's formal-review,
  issue-approval, and watch-gate-verdict handling respectively.
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
- GitHub's own `token` config is now optional: when absent, the GitHub
  provider resolves a credential from the sandboxed GitHub CLI (`gh auth
  token`) at construction time, and fails to construct — a failure Provider
  Composition tolerates rather than crashing — when neither a configured
  token nor a usable CLI credential is available.

## Task 27B synchronization (2026-08-02)

Artifact claims are provider-verified before discovery/correlation. Transient verification uncertainty is checkpoint-independent, bounded, and escalated durably; confirmed negatives are failed. Delivery unknown reconciliation is likewise bounded and marks an intent escalated, after which only an operator resolution or a confirmed provider result can clear it. GitHub review intake consumes formal review evidence for PR review commands, plus separate issue-comment evidence for issue-level approval commands and watch-gate verdict markers (see GitHub Inbound Translation). Each tick also reconciles Wake-owned GitHub status/stage/workflow labels for correlated resources while preserving user labels; labels are presentation, not commands that mutate arbitrary workflow stages.

## Task 27 synchronization (2026-08-10)

Fake pull-request evidence may identify the reviewing actor, whether it is a
human or bot, and the configured reviewer identity used to authorize an
accepted-review signal. These fixture inputs exercise the same review-trust
rules as provider evidence; omitted values retain the deterministic fake
reviewer defaults.

## GitHub transport synchronization (2026-08-11)

The concrete GitHub client is independently contract-tested at the Octokit
boundary: a configured token is supplied to Octokit and a `401` authentication
failure is preserved; bounded issue reads use conditional ETag requests after
an ETag-bearing response; and merge and reply delivery map to the exact
GitHub requests (including the durable reply marker) while preserving provider
failures. Actual Octokit `429`/`500` request failures produce redacted
diagnostic output, while routine `304 Not Modified` traffic is quiet. These
tests do not claim a raw multi-page source-ordering compatibility contract.
