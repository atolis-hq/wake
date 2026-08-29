# Projection Subscription and Rebuilder - Component Specification

## Type, purpose, and scope

Policy/process. Projection subscription helpers adapt a projection definition
to a durable subscription and deterministically apply each bounded handler
batch. ProjectionRebuilder clears and replays one projection from the Event
Journal to the Projection Store, recording progress in the Checkpoint Store
under the same consumer identity as the live subscription.

## Ubiquitous language

- **Projection consumer** - the stable durable-subscription identity
  `projection:<definition name>`, used for both checkpoints and keyed run
  serialisation.
- **Projection batch** - the bounded journal events given to the durable
  subscription handler after checkpoint load and before checkpoint save.
- **Rebuild** - a consumer-locked clear, checkpoint reset, and bounded replay
  to the current journal head.

## Responsibilities and boundaries

`projectionConsumer` derives the stable consumer name.
`createProjectionSubscription` returns a durable subscription with that name,
a batch size of 100, and a handler that delegates to `applyProjectionBatch`.
`applyProjectionBatch` owns selection, folding, and position-stamped writes;
the Durable Subscription Host owns the successful-handler checkpoint save.
ProjectionRebuilder owns clear, reset, bounded replay, and checkpoint saves
while holding that same consumer-keyed serialisation. None of these components
define what a projection fold means or decide when a live subscription runs.

## Core policies, invariants, and behaviours

- Each supplied event is selected and folded in journal order. An unselected
  event writes no projection value.
- A projection write has the source event's `globalPosition`. If the stored
  value already has an equal or greater `lastGlobalPosition`, the event is not
  folded again. This makes a batch safe to replay after its writes succeed but
  before its durable checkpoint save succeeds.
- A projection definition's initial value is used only for the first write of
  a key; subsequent events fold onto the stored value.
- The durable subscription host checkpoints every successfully handled batch,
  including one with no selected events.
- Rebuild acquires the consumer lock before clear/reset and holds it through
  all bounded journal reads, projection writes, and checkpoint saves. A live
  pass with that consumer therefore cannot interleave with rebuild. A sibling
  projection consumer can make progress independently.
- Rebuild reads at most 100 events per journal call, returns the total number
  of replayed events, and finishes only after an empty read confirms the
  journal head is stable for that rebuild pass.
- Rebuild only clears and resets the definition it was asked to rebuild.

## Dependencies and system role

- Kernel supplies projection definitions, event envelopes, and storage port
  contracts.
- Event Journal supplies ordered bounded replay batches.
- Projection Store receives position-stamped folded values and namespace
  clears.
- Checkpoint Store records the durable projection consumer position.
- Durable Subscription Host supplies live batches and checkpoints them after
  handler success.
- SubscriptionRunSerialiser supplies consumer-keyed exclusion for both live
  passes and rebuilds.
- Bootstrap composes runtime definitions into independently durable projection
  subscriptions and delegates each rebuild to this component.

## Decisions, exclusions, and deferred capability

- There is no partial or per-key rebuild.
- The batch size is a fixed code default, not operator configuration.
- ProjectionRebuilder does not supervise live subscriptions; the Durable
  Subscription Host owns retries, health, cancellation, and waiting.
