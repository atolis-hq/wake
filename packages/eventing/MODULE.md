# eventing

## Purpose

Persistence-neutral event contracts, journal and state ports, projections,
processor runtime, and in-memory adapters.

## Owns

Event data and envelopes, event identifiers and metadata, journal change
signalling, checkpoint/projection/processor-state ports, processor vocabulary,
hosting, replay, health, and memory implementations.

## Does not own

Wake domain event schemas, filesystem or Node adapter implementation, Wake-home
paths, Bootstrap composition, providers, or workflow policy.

## Public contracts

The package root and `/memory` export path are the only supported imports.

## Invariants

`ProjectionStore` is for rebuildable read models; `ProcessorStateStore` is for
consumer-owned recovery state. The package imports neither Wake source modules
nor Node filesystem APIs.

## Extension rules

Define portable contracts and runtime capabilities here. Put a concrete storage
adapter in its own package and compose it in the consuming application.
