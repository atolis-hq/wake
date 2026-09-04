# Delivery Intent Projection — Component Specification

## Type, purpose, and scope

Projection. This component folds a delivery intent's requesting fact plus
this module's own `delivery.*` facts into a `DeliveryIntentView` per intent,
and exposes the subset still actionable (`pending` or `ambiguous`) as the
Delivery aggregate's work queue.

## Responsibilities and boundaries

This projection owns recognizing an intent's requesting fact (whichever
kind it is), initializing its view, and folding every subsequent
`delivery.*` fact recorded against that same intent into state, attempt
count, and occurrence ordinal. It does not decide whether an intent is
eligible to exist, does not attempt delivery itself, and does not decide
what a resolved outcome means to a workflow.

## Core policies, invariants, and behaviours

- A `DeliveryIntentView` MUST be created the moment its requesting fact
  (`pr.approve-requested`, `pr.merge-requested`, `status.publish-requested`,
  `reply.publish-requested`, or `agent-run.publish-requested`) is observed,
  at state `pending`, zero attempts, and occurrence ordinal zero, keyed by
  that fact's own event id.
- A `delivery.*` fact whose `intentEventId`/`intentGlobalPosition` does not
  match the view it would otherwise apply to MUST be ignored, leaving the
  view unchanged.
- Folding a `delivery.*` fact MUST advance the view's `occurrenceOrdinal` to
  the greater of its current value and the fact's own occurrence ordinal.
- `delivery.attempt-started` MUST increment `attempts`. `delivery.confirmed`,
  and a `delivery.reconciled` fact whose result is `confirmed`, MUST set
  state to `confirmed`. `delivery.failed` MUST set state to `failed`.
  `delivery.ambiguous` MUST set state to `ambiguous` and record its
  reconciliation key. A `delivery.reconciled` fact with any other result
  MUST NOT change state.
- The exposed view list MUST include only intents currently in `pending` or
  `ambiguous` state, sorted by the requesting fact's own journal position.
- This projection MUST be rebuildable purely by refolding its source facts
  in journal order; it retains no state beyond that fold.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `pr.approve-requested` / `pr.merge-requested` | Activities' PR Approve & Merge Decision records a delivery intent | An approve/merge delivery intent now exists for this projection to track. |
| `status.publish-requested` / `reply.publish-requested` | A status/reply-publish Activity records a delivery intent | A status/reply delivery intent now exists for this projection to track. |
| `agent-run.publish-requested` | Agent Run Publication records a terminal run's own report | An agent-run delivery intent now exists for this projection to track. |
| `delivery.attempt-started` / `delivery.confirmed` / `delivery.failed` / `delivery.ambiguous` / `delivery.reconciled` | The Delivery aggregate records an attempt or outcome fact | The tracked intent's state, attempt count, or occurrence ordinal advances. |

## Conceptual schema

See the module page's `DeliveryIntentView` table for the full field list;
this component is that view's sole projector.

## Dependencies and system role

- Activities (this projection depends on it) — reads the
  `pr.approve-requested`/`pr.merge-requested` facts Activities' PR Approve &
  Merge Decision records; never writes them.
- Agent Run Publication (this projection depends on it) — reads the
  `agent-run.publish-requested` facts it records; never writes them.
- Eventing — event reading and sorting conventions this projection folds
  over.
- Delivery aggregate — supplies this projection's own `delivery.*` source
  facts, and in turn depends on this projection's output as its work queue;
  see the Delivery component page for the shared loop this forms.
- Delivery Outcome Reactor does not depend on this projection: it reads
  `delivery.*` facts directly from the journal rather than through this
  view.

## Decisions, exclusions, and deferred capability

- The exposed view intentionally excludes confirmed and failed intents;
  their full history remains in the event log, not in this read model.
