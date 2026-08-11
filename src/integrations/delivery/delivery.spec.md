# Delivery — Component Specification

## Type, purpose, and scope

Aggregate. Delivery drives one attempt cycle for the next pending or
ambiguous delivery intent, recording attempt and outcome facts on that
intent's own `delivery` stream, and defines the `ExternalDeliveryAdapter`
contract every provider implements to actually perform and reconcile the
external effect.

## Ubiquitous language

- **Occurrence** — one attempt cycle against a single intent, numbered by
  `occurrenceOrdinal`; a fresh occurrence either records an attempt/outcome
  pair or, when reconciling, a single reconciled fact.
- **DeliveryResult** — an `ExternalDeliveryAdapter.deliver` call's own
  outcome: `confirmed` (with an external id), `failed` (with a code and
  message), or `ambiguous` (with a reconciliation key).
- **ReconciliationResult** — an `ExternalDeliveryAdapter.reconcile` call's
  own outcome: `confirmed` (with an external id), `not-found`, or `unknown`.
  These are a different, narrower set than `DeliveryResult`; a reconcile
  call never itself reports `failed` or `ambiguous`.

## Responsibilities and boundaries

Delivery owns picking the next intent to attempt from its injected intent
source, the reconcile-before-retry rule, appending attempt/outcome facts
with deterministic per-occurrence event ids, and resolving which provider
adapter delivers a given intent's Resource. It does not decide which intents
exist or their current state — that is the Delivery Intent Projection. It
does not decide what an outcome means to a workflow — that is the Delivery
Outcome Reactor. It does not itself know how any specific provider performs
or reconciles an effect — that is each provider's own delivery adapter.

## Core policies, invariants, and behaviours

Delivery is intentionally not a generic multi-sink fanout router: one intent
is addressed to one Resource and therefore one provider adapter.

- `deliverNext` MUST pick the first pending-or-ambiguous intent its injected
  intent source returns; when none exists, it MUST record no facts and
  return nothing.
- The intent source exposes actionable intents in requesting journal order.
  Delivery processes one such intent per call; a terminal failure for one
  intent must leave later intents independently actionable in their order.
- An intent whose Resource cannot be resolved MUST fail the call outright
  (not record a per-intent outcome fact); this is a hard error for the
  cycle, not a delivery outcome.
- Before a fresh delivery attempt, when the intent is already `ambiguous` or
  has at least one prior attempt, Delivery MUST call the resolved adapter's
  `reconcile` first and record its result as `delivery.reconciled`. When
  that result is anything other than `not-found` (confirmed or unknown),
  Delivery MUST stop this cycle for this intent without attempting delivery;
  only `not-found` permits proceeding to a fresh attempt.
- Each occurrence MUST use an `occurrenceOrdinal` one greater than the
  intent's current value, and every fact recorded for that occurrence MUST
  derive its own event id from the intent's event id, the fact's own event
  type, and that occurrence ordinal, so no two occurrences' facts can
  collide.
- A fresh attempt MUST record `delivery.attempt-started` before calling the
  adapter's `deliver`, so a crash between the two leaves durable evidence
  that the occurrence was attempted but not yet resolved.
- The adapter's `deliver` result MUST record exactly one of
  `delivery.confirmed`, `delivery.failed`, or `delivery.ambiguous` for that
  occurrence — never more than one outcome fact per attempt.
- A `delivery.reconciled` fact's result MUST be `confirmed` (with an
  external id), `not-found`, or `unknown`; only `confirmed` changes the
  intent's delivery state.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `delivery.attempt-started` | Delivery begins a fresh attempt against an intent | This occurrence has begun; a later cycle without a terminal fact after this one must reconcile rather than re-attempt. |
| `delivery.confirmed` | The adapter's `deliver` call reports success | The intent's external effect is durably done. |
| `delivery.failed` | The adapter's `deliver` call reports failure | The intent's external effect is durably failed; no further automatic attempt is made. |
| `delivery.ambiguous` | The adapter's `deliver` call cannot determine the result | The intent stays eligible for a further cycle, which reconciles first. |
| `delivery.reconciled` | A reconcile call against the provider resolves, or fails to resolve, an ambiguous or interrupted occurrence | Either the intent is now known confirmed, or its uncertainty persists. |

## Conceptual schema

**DeliveryEventCorrelation** (shared by every `delivery.*` fact)

| Field | Type | Description |
| --- | --- | --- |
| `intentEventId` | Event identity | The requesting fact's event id; also the stream's own identity. |
| `intentGlobalPosition` | integer | The requesting fact's journal position, carried for defensive cross-checking. |
| `workflowInstanceId` | Workflow instance identity | Where this delivery's outcome is ultimately reported. |
| `activationId` | Activation identity | Which activation this delivery's outcome corresponds to. |
| `occurrenceOrdinal` | integer | Which attempt cycle this fact belongs to. |

**ExternalDeliveryAdapter** (the contract every provider implements)

| Field | Type | Description |
| --- | --- | --- |
| `deliver` | function(intent, signal) → DeliveryResult | Performs the intent's external effect once. |
| `reconcile` | function(reconciliationKey, signal) → ReconciliationResult | Re-queries the provider for an already-attempted effect instead of repeating it. |

## Dependencies and system role

- Kernel — event journal append/read for the per-intent `delivery` stream.
- Delivery Intent Projection — supplies the pending/ambiguous intents this
  component attempts, and in turn folds this component's own `delivery.*`
  facts back into each intent's view; the two form a closed read/write loop
  over the same durable facts, each depending on the other's output.
- Resources (depends on it indirectly) — a `DeliveryResourceLookup`
  resolves which adapter owns an intent's Resource; Delivery reads this
  through an injected lookup rather than calling Resources directly.
- Each provider's own delivery adapter (GitHub Outbound Delivery, the fake
  durable delivery provider) — depended on by this component through
  `ExternalDeliveryAdapter`; Delivery itself is provider-agnostic.
- Delivery Outcome Reactor (depends on this component) — reads the
  `delivery.*` facts this component records to notify Orchestration.

## Decisions, exclusions, and deferred capability

- Delivery does not itself pace or back off between cycles; it performs one
  cycle per call, and its caller decides how often to call it.
- A `failed` intent is terminal from this component's own point of view: its
  intent source only ever offers pending/ambiguous intents, so a failed
  intent is never re-attempted by Delivery again.
