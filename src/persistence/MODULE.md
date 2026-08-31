# persistence

## Purpose

Temporary ownership of the `persistence` configuration namespace while the
remaining module cleanup is completed.

## Owns

No Eventing filesystem adapter. Those adapters are owned by
`@atolis-hq/eventing-filesystem`.

## Does not own

Eventing filesystem storage, processor definitions, handlers, host lifecycle,
domain policy, or composition.

## Invariants

It is not a compatibility barrel for moved adapters. Bootstrap imports the
filesystem package directly when it composes durable Eventing storage.

## Public contracts

`index.ts` remains only until the module can be removed; it exports no moved
filesystem adapter.

## Configuration

Owns the `persistence` namespace for future storage options. Current paths are
selected by Bootstrap.

## Relations and events

Persists envelopes without defining domain event or relation semantics.

## Failure and recovery

Filesystem recovery and locking behavior belongs to the Eventing filesystem
package. Projection rebuild locking and processor retry are Eventing policies.

## Extension rules

Do not add filesystem adapters or compatibility exports here. Keep event
selection, bounded event construction and decoding, handlers, and runtime
lifecycle in their owning modules.

## Scenarios

E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
