# bootstrap

## Purpose

Configuration loading, dependency composition, and process startup.

## Owns

Root schema composition, paths, concrete adapter selection, the complete
Eventing processor registry, runtime supervision, and process hosts.

## Does not own

Domain policy, provider payloads, Persistence semantics, or processor handler
logic.

## Invariants

Only Bootstrap knows the complete application graph. It constructs the one
Eventing host, registers every resident projection, reactor, coordinator, and
translator exactly once, and composes the Eventing filesystem adapters. The
activation scheduler and projections use the same processor runtime while
startup, fallback reconciliation, schedules, polling, delivery, and surface
diagnostics remain explicit lanes.

## Public contracts

`index.ts` is the only public entry.

## Configuration

Owns root configuration loading and Bootstrap composition.

## Relations and events

Defines no canonical event or relation semantics.

## Failure and recovery

Supervised processors report volatile health and preserve durable checkpoints.
Bootstrap exposes composition and reconciliation diagnostics without mutating
facts.

## Extension rules

Select concrete adapters here and register processor definitions here. Domain
and adapter modules may define processors but must not construct Eventing's
host or Eventing filesystem adapters.

## Scenarios

E2E-CONFIG-001, E2E-OPS-INIT-001, E2E-OPS-001.
