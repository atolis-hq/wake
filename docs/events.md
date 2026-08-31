# Wake events

Wake stores immutable, globally ordered event envelopes. The append-only
journal is the durable record; projections are rebuildable read models and
never define or reconstruct events.

## Event record model

An owning module creates immutable `EventData`: event identity and type,
schema version, occurrence and causal metadata, actor, source, and typed
payload. `EventData` has no stream or journal metadata.

The journal records `EventEnvelope<EventData>` by adding the stream,
`recordedAt`, stream `sequence`, and `globalPosition`. Modules append a
non-empty batch with `appendToStream(stream, expectedSequence, events)`.
`expectedSequence` is optimistic concurrency; modules choose conflict handling
and idempotency. The journal does not apply automatic retry or a general
deduplication policy.

The filesystem adapter writes the exact established flat JSONL record through
the Persistence codec. The in-memory adapter holds the nested envelope model.
Those representations are compatible reads of the same record, so no journal
data migration or projection rebuild is required.

## Event ownership

Event types are owned by the bounded module that defines their payload schema.
Use that module's `contracts/events.ts` as the exact catalogue and decoder:

| Owner | Event namespace / role |
| --- | --- |
| `work` | `work.` facts for a work item's objective, links, lifecycle controls, and closure. |
| `resources` | `resources.` facts for discovered external resources and work-item correlation. |
| `conversations` | `conversation.` facts for a work item's canonical, immutable discussion history. |
| `activities` | `activities.`, `pr.`, and `review.` facts and decisions for activities. |
| `orchestration` | `orchestration.` facts for instances, activations, stages, signals, child workflows, and outcomes. |
| `execution` | `execution.` facts for runs, leases, runner results, cancellation, and recovery. |
| `control-plane` | `control.` facts for control-plane coordination and runner quotas. |
| `integrations` | Provider observations, artifact facts, and delivery intents/outcomes. GitHub-specific contracts live in `src/integrations/github/contracts/events.ts`. |

## Event catalogue overview

The following table highlights the principal stable Wake-owned events; it is
an overview, not an exhaustive registry. The complete event names, exact
payloads, and permitted streams are defined by each owning module's contract
source linked by the ownership table above.

| Owner | Event types |
| --- | --- |
| `work` | `work.item-created`, `work.objective-revised`, `work.item-linked`, `work.item-closed`, `work.item-cancelled`, `work.auto-approval-granted`, `work.auto-approval-revoked`, `work.item-frozen`, `work.item-unfrozen`, `work.item-deleted` |
| `resources` | `resources.resource-discovered`, `resources.resource-revision-observed`, `resources.work-correlation-established`, `resources.work-correlation-retracted`, `resources.work-correlation-conflicted` |
| `conversations` | `conversation.created`, `conversation.resource-associated`, `conversation.entry-recorded`, `conversation.entry-revised`, `conversation.entry-tombstoned`, `conversation.entry-representation-recorded` |
| `activities` | `pr.discovered`, `pr.revision-changed`, `pr.state-changed`, `pr.checks-changed`, `pr.review-accepted`, `review.acceptance-signal-recorded`, `pr.review-changes-requested`, `pr.review-rejected`, `pr.merge-denied`, `pr.approve-denied`, `pr.merge-authorized`, `pr.approve-requested`, `pr.merge-requested`, `pr.approve-decision-claimed`, `pr.merge-decision-claimed` |
| `orchestration` | `orchestration.instance-started`, `orchestration.stage-entered`, `orchestration.activity-requested`, `orchestration.activity-started`, `orchestration.activity-outcome-accepted`, `orchestration.activity-execution-failed`, `orchestration.activity-retried-for-runner-quota`, `orchestration.activity-waiting`, `orchestration.signal-wait-started`, `orchestration.signal-accepted`, `orchestration.supplemental-activity-queued`, `orchestration.supplemental-activity-dequeued`, `orchestration.repeat-counted`, `orchestration.retry-counted`, `orchestration.instance-completed`, `orchestration.instance-blocked`, `orchestration.operator-retry-requested`, `orchestration.instance-superseded`, `orchestration.child-requested`, `orchestration.child-started`, `orchestration.child-completed`, `orchestration.child-completion-consumed`, `orchestration.causal-activation-rejected`, `orchestration.group-budget-exhausted`, `orchestration.primary-claimed`, `orchestration.group-claimed` |
| `execution` | `execution.run-preparation-started`, `execution.run-started`, `execution.run-succeeded`, `execution.run-failed`, `execution.run-lease-claimed`, `execution.run-lease-renewed`, `execution.run-external-execution-reported`, `execution.run-runner-result-reported`, `execution.workspace-cleanup-failed`, `execution.run-cancellation-requested`, `execution.run-cancellation-confirmed`, `execution.run-cancelled`, `execution.run-recovered`, `execution.run-ambiguity-observed`, `execution.run-ambiguous`, `execution.activation-claimed`, `execution.activation-released` |
| `control-plane` | `control-plane.dispatch-paused`, `control-plane.dispatch-resumed`, `control-plane.runner-paused`, `control-plane.runner-resumed` |
| `integrations` | `integration.github.work-observed`, `integration.github.comment-observed`, `integration.github.delivery-observed`, `integration.artifact-verification-unresolved`, `delivery.attempt-started`, `delivery.confirmed`, `delivery.failed`, `delivery.ambiguous`, `delivery.reconciled`, `delivery.escalated` |

An event must be written only to the stream kind required by its schema. Each
bounded module owns its event types, payload map, stream references,
selector/decoder, and `create<Owner>EventData` factory. These contracts enforce
event-type-to-stream ownership at compile time and at runtime when persisted
data is decoded. Selectors return `null` for another module's namespace and
throw if an event in their own namespace is malformed.

## Event handling rules

- Preserve the original envelope and append a new fact; never mutate an event
  to represent a later state.
- Decode persisted data before folding it into a domain object or projection.
- Keep provider payload validation at the integration boundary, then translate
  it into typed Wake facts.
- Record a conversation entry only through `conversations`; provider adapters
  first emit their own observation and then submit the provider-neutral
conversation command after work correlation. Conversation entries do not
choose outbound targets or workflow transitions.
- Inbound translation creates the deterministic conversation stream when a
  correlated historical WorkItem does not yet have one. Agent context excludes
  tombstoned entries, honors its resume cutoff, and preserves provider-supplied
  inline locations.
- Re-observation of the same provider message records a revision of its
  canonical entry. A Wake delivery marker reconciles an observed echo with the
  existing agent entry even before delivery reconciliation records its external
  representation.
- Conversation provenance is optional to delivery and reply progression: a
  failed provenance write does not block a delivery-result outcome or a
  terminal agent reply.
- Express cross-module links with the exported stream identifiers and relation
  vocabulary, not magic strings or copied provider locators.
- Register production projections in Bootstrap so replay and normal operation
  observe the same event sequence.
- Eventing hosts durable subscriptions, checkpoints, and projections without
  domain knowledge. Persistence records, loads, and signals changes without
  domain knowledge. Bootstrap composes the processor registry and module
  factories; only surfaces flatten an envelope for external transport.
- The delivery outcome reactor keeps ProjectionStore-backed recovery state for
  pending confirmations. This is not a rebuildable Eventing projection: it
  reads legacy flat and interim nested stored records during recovery, then
  writes the reactor-owned canonical pending-confirmations record.

`check-event-architecture` is a symbol-aware architecture gate. It enforces
publishing and processor ownership, bounded imports, legacy-vocabulary bans,
and manifest namespaces. The existing narrow ports also leave a future seam:
SQLite, Emmett, or Kurrent adapters can sit behind `EventJournal` and Eventing
when they preserve Wake's compatibility, global-order, push-wake, checkpoint,
and lock semantics.

For the current module topology and advancement path, see
[Architecture](architecture.md).
